import asyncio
import logging
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
# Local overrides (untracked): keeps API keys out of the git-tracked .env file.
load_dotenv(BASE_DIR / ".env.local", override=True)
from typing import Any, Dict, List, Literal, Optional
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from ai_assistant import ask_mesh_ai, get_ai_config
from insights import calculate_insights
from pydantic import BaseModel, Field
from receiver import MeshReceiver

logger = logging.getLogger("esp_mesh_dashboard")

FRONTEND_DIR = BASE_DIR / "frontend"
receiver = MeshReceiver()


class AutoSleepCycle:
    def __init__(self, mesh_receiver):
        self.receiver = mesh_receiver
        self.sleep_ms = None
        self.wake_grace_ms = None
        self.status = "stopped"
        self.last_error = None
        self.task = None

    def snapshot(self):
        active = self.task is not None and not self.task.done()
        return {
            "active": active,
            "status": self.status,
            "sleepMs": self.sleep_ms,
            "wakeGraceMs": self.wake_grace_ms,
            "error": self.last_error,
        }

    def start(self, sleep_ms, wake_grace_ms):
        if self.task is not None and not self.task.done():
            raise ValueError("Auto sleep mode is already running")

        self.receiver.write_command(f"DEEP_SLEEP {sleep_ms}")
        self.sleep_ms = sleep_ms
        self.wake_grace_ms = wake_grace_ms
        self.last_error = None
        self.status = "sleeping"
        self.task = asyncio.create_task(self._run())
        return self.snapshot()

    async def stop(self):
        task = self.task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self.task = None
        self.status = "stopped"
        return self.snapshot()

    async def _run(self):
        try:
            while True:
                await asyncio.sleep(self.sleep_ms / 1000)
                self.status = "wake_grace"
                await asyncio.sleep(self.wake_grace_ms / 1000)
                self.status = "sending_sleep"
                self.receiver.write_command(f"DEEP_SLEEP {self.sleep_ms}")
                self.status = "sleeping"
        except asyncio.CancelledError:
            self.status = "stopped"
            raise
        except (ConnectionError, OSError) as exc:
            logger.warning("Auto sleep cycle stopped after a gateway error: %s", exc)
            self.last_error = str(exc)
            self.status = "error"
        finally:
            self.task = None


auto_sleep_cycle = AutoSleepCycle(receiver)


def _safe_broadcast(receiver_inst: MeshReceiver, event: dict, loop: asyncio.AbstractEventLoop):
    try:
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(receiver_inst.broadcast_event(event), loop)
    except RuntimeError:
        pass


async def _process_line(receiver_inst: MeshReceiver, line: str, transport_name: str):
    try:
        event = receiver_inst.handle_message(line)
        await receiver_inst.broadcast_event(event)
    except Exception as exc:
        logger.warning("Malformed or ignored %s gateway line: %s (%s)", transport_name, line, exc)


def _safe_dispatch_line(receiver_inst: MeshReceiver, line: str, loop: asyncio.AbstractEventLoop, transport_name: str):
    try:
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(_process_line(receiver_inst, line, transport_name), loop)
    except RuntimeError:
        pass


def _serial_worker(receiver_inst: MeshReceiver, loop: asyncio.AbstractEventLoop, stop_event: threading.Event):
    import serial

    while not stop_event.is_set():
        if not receiver_inst.connected or receiver_inst.transport is None:
            serial_port = os.getenv("MESH_SERIAL_PORT")
            if not serial_port:
                receiver_inst.connected = False
                receiver_inst.gateway_message = "Serial transport selected but no serial port configured."
                if stop_event.wait(2.0):
                    break
                continue

            try:
                ser = serial.Serial(serial_port, 115200, timeout=1.0)
                receiver_inst.transport = ser
                receiver_inst.connected = True
                receiver_inst.gateway_message = f"Connected to serial gateway {serial_port}"
                _safe_broadcast(
                    receiver_inst,
                    {
                        "type": "status",
                        "status": "connected",
                        "gatewayConnected": True,
                    },
                    loop,
                )
            except Exception as exc:
                receiver_inst.connected = False
                receiver_inst.gateway_message = f"Unable to open serial port {serial_port}"
                if stop_event.wait(2.0):
                    break
                continue

        ser = receiver_inst.transport
        try:
            raw_line = ser.readline()
            if not raw_line:
                continue
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            _safe_dispatch_line(receiver_inst, line, loop, "serial")

        except (serial.SerialException, OSError) as exc:
            logger.warning("Serial disconnect error: %s", exc)
            receiver_inst.connected = False
            receiver_inst.gateway_message = "Serial port disconnected"
            try:
                ser.close()
            except Exception:
                pass
            receiver_inst.transport = None
            _safe_broadcast(
                receiver_inst,
                {
                    "type": "status",
                    "status": "disconnected",
                    "gatewayConnected": False,
                },
                loop,
            )
            if stop_event.wait(2.0):
                break

    if receiver_inst.transport:
        try:
            receiver_inst.transport.close()
        except Exception:
            pass
        receiver_inst.transport = None
    receiver_inst.connected = False

def _tcp_worker(receiver_inst: MeshReceiver, loop: asyncio.AbstractEventLoop, stop_event: threading.Event):
    import socket

    while not stop_event.is_set():
        if not receiver_inst.connected or receiver_inst.transport is None:
            host = os.getenv("MESH_HOST")
            port = os.getenv("MESH_PORT")
            if not host or not port:
                receiver_inst.connected = False
                receiver_inst.gateway_message = "TCP transport configured but no host/port provided."
                if stop_event.wait(2.0):
                    break
                continue

            try:
                port_value = int(port)
                sock = socket.create_connection((host, port_value), timeout=5.0)
                sock.settimeout(1.0)
                receiver_inst.transport = sock
                receiver_inst.connected = True
                receiver_inst.gateway_message = f"Connected to gateway at {host}:{port_value}"
                _safe_broadcast(
                    receiver_inst,
                    {
                        "type": "status",
                        "status": "connected",
                        "gatewayConnected": True,
                    },
                    loop,
                )
            except (OSError, ValueError) as exc:
                receiver_inst.connected = False
                receiver_inst.gateway_message = f"Unable to connect to {host}:{port}"
                if stop_event.wait(2.0):
                    break
                continue

        sock = receiver_inst.transport
        buffer = b""
        try:
            while not stop_event.is_set():
                try:
                    chunk = sock.recv(1024)
                    if not chunk:
                        raise OSError("TCP connection closed by remote gateway")
                    buffer += chunk
                    while b"\n" in buffer:
                        raw_line, buffer = buffer.split(b"\n", 1)
                        line = raw_line.decode("utf-8", errors="replace").strip()
                        if not line:
                            continue
                        _safe_dispatch_line(receiver_inst, line, loop, "TCP")
                except socket.timeout:
                    continue
        except (OSError, socket.error) as exc:
            logger.warning("TCP gateway disconnect error: %s", exc)
            receiver_inst.connected = False
            receiver_inst.gateway_message = "TCP gateway disconnected"
            try:
                sock.close()
            except Exception:
                pass
            receiver_inst.transport = None
            _safe_broadcast(
                receiver_inst,
                {
                    "type": "status",
                    "status": "disconnected",
                    "gatewayConnected": False,
                },
                loop,
            )
            if stop_event.wait(2.0):
                break

    if receiver_inst.transport:
        try:
            receiver_inst.transport.close()
        except Exception:
            pass
        receiver_inst.transport = None
    receiver_inst.connected = False


@asynccontextmanager
async def lifespan(app_inst: FastAPI):
    transport = os.getenv("MESH_TRANSPORT", "serial").lower()
    stop_event = threading.Event()
    worker_thread = None

    loop = asyncio.get_running_loop()
    if transport == "serial":
        worker_thread = threading.Thread(
            target=_serial_worker,
            args=(receiver, loop, stop_event),
            name="serial-gateway-worker",
            daemon=True,
        )
        worker_thread.start()
    elif transport == "tcp":
        worker_thread = threading.Thread(
            target=_tcp_worker,
            args=(receiver, loop, stop_event),
            name="tcp-gateway-worker",
            daemon=True,
        )
        worker_thread.start()
    try:
        yield
    finally:
        await auto_sleep_cycle.stop()
        if worker_thread:
            stop_event.set()
            worker_thread.join(timeout=2.0)


app = FastAPI(title="ESP32 Mesh Dashboard", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response



@app.get("/")
async def index():
    return FileResponse(FRONTEND_DIR / "dashboard.html")


@app.get("/health")
async def health():
    return receiver.get_health()


class MeshCommandRequest(BaseModel):
    command: Literal["SEND_DATA", "CHANGE_INTERVAL", "DEEP_SLEEP"]
    intervalMs: Optional[int] = Field(default=None, ge=1, le=4294967295)
    sleepMs: Optional[int] = Field(default=None, ge=1, le=4294967295)


class AutoSleepRequest(BaseModel):
    sleepMs: int = Field(ge=1, le=4294967295)
    wakeGraceMs: int = Field(ge=0, le=4294967295)


@app.get("/api/mesh/auto-sleep")
async def get_auto_sleep_status():
    return auto_sleep_cycle.snapshot()


@app.post("/api/mesh/auto-sleep")
async def start_auto_sleep(request: AutoSleepRequest):
    try:
        return auto_sleep_cycle.start(request.sleepMs, request.wakeGraceMs)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (ConnectionError, OSError) as exc:
        logger.warning("Unable to start auto sleep mode: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.delete("/api/mesh/auto-sleep")
async def stop_auto_sleep():
    return await auto_sleep_cycle.stop()


@app.post("/api/mesh/commands")
async def send_mesh_command(request: MeshCommandRequest):
    if request.command == "SEND_DATA" and (request.intervalMs is not None or request.sleepMs is not None):
        raise HTTPException(status_code=400, detail="SEND_DATA does not accept a duration")
    if request.command == "CHANGE_INTERVAL" and request.intervalMs is None:
        raise HTTPException(status_code=400, detail="CHANGE_INTERVAL requires intervalMs")
    if request.command == "CHANGE_INTERVAL" and request.sleepMs is not None:
        raise HTTPException(status_code=400, detail="CHANGE_INTERVAL does not accept sleepMs")
    if request.command == "DEEP_SLEEP" and request.sleepMs is None:
        raise HTTPException(status_code=400, detail="DEEP_SLEEP requires sleepMs")
    if request.command == "DEEP_SLEEP" and request.intervalMs is not None:
        raise HTTPException(status_code=400, detail="DEEP_SLEEP does not accept intervalMs")

    command = request.command
    if request.command == "CHANGE_INTERVAL":
        command = f"CHANGE_INTERVAL {request.intervalMs}"
    elif request.command == "DEEP_SLEEP":
        command = f"DEEP_SLEEP {request.sleepMs}"

    try:
        receiver.write_command(command)
    except (ConnectionError, OSError) as exc:
        logger.warning("Unable to send mesh command %s: %s", request.command, exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"sent": True, "command": command}


@app.get("/nodes")
async def list_nodes():
    return {"nodes": receiver.list_nodes()}


@app.get("/nodes/{node_id}")
async def get_node(node_id: str):
    node = receiver.get_node(node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    return node


@app.get("/nodes/{node_id}/history")
async def get_history(node_id: str, since: str | None = None, limit: int = Query(default=100, ge=1, le=1000)):
    history = receiver.get_history(node_id, since=since, limit=limit)
    return {"nodeId": node_id, "samples": history}


@app.get("/nodes/{node_id}/insights")
async def get_insights(node_id: str):
    node = receiver.get_node(node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    history = receiver.get_history(node_id, limit=1000)
    return calculate_insights(node_id, history, node=node)


@app.websocket("/live")
async def live_updates(websocket: WebSocket):
    await websocket.accept()
    receiver.add_client(websocket)
    await websocket.send_json({
        "type": "status",
        "status": "connected",
        "gatewayConnected": receiver.connected,
    })

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        receiver.remove_client(websocket)


class ChatRequest(BaseModel):
    message: str
    nodeId: Optional[str] = None
    history: Optional[List[Dict[str, Any]]] = None


ChatRequest.model_rebuild()


@app.get("/api/ai/status")
async def ai_status():
    config = get_ai_config()
    return {
        "configured": config["configured"],
        "model": config["model"] if config["configured"] else None,
        "provider": config["provider"],
        "baseUrl": config["base_url"],
    }


@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    if not request.message or not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    result = await ask_mesh_ai(
        message=request.message,
        history=request.history,
        selected_node_id=request.nodeId,
        receiver=receiver,
    )
    return result


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
