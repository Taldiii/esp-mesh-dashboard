import json
import os
import socket
import threading
from collections.abc import MutableSet

from history import HistoryBuffer
from mesh_protocol import normalize_message


def node_aliases():
    """Optional friendly names: NODE_ALIASES={"AA:BB:..":"Tentative 1"}."""
    raw = os.getenv("NODE_ALIASES", "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(key): str(value).strip() for key, value in data.items() if str(value).strip()}


def node_display_name(node_id):
    return node_aliases().get(node_id) or node_id


class MeshReceiver:
    def __init__(self, max_history=1000):
        self.history = HistoryBuffer(limit=max_history)
        self.nodes = {}
        self.connected = False
        self.gateway_message = "Gateway not configured"
        self.transport = None
        self.transport_write_lock = threading.Lock()
        self.websocket_clients = set()

    def write_command(self, command):
        with self.transport_write_lock:
            transport = self.transport
            if not self.connected or transport is None:
                raise ConnectionError("Mesh gateway is not connected")

            payload = f"{command}\n".encode("ascii")
            write = getattr(transport, "write", None)
            if callable(write):
                written = write(payload)
                if written != len(payload):
                    raise OSError("Incomplete command write to serial gateway")
                flush = getattr(transport, "flush", None)
                if callable(flush):
                    flush()
                return

            sendall = getattr(transport, "sendall", None)
            if callable(sendall):
                sendall(payload)
                return

            raise OSError("Configured gateway transport cannot send commands")

    def add_client(self, websocket):
        self.websocket_clients.add(websocket)

    def remove_client(self, websocket):
        self.websocket_clients.discard(websocket)

    async def broadcast_event(self, event):
        for client in list(self.websocket_clients):
            try:
                await client.send_json(event)
            except Exception:
                self.websocket_clients.discard(client)

    def connect_gateway(self):
        transport = os.getenv("MESH_TRANSPORT", "tcp").lower()

        if transport == "tcp":
            host = os.getenv("MESH_HOST")
            port = os.getenv("MESH_PORT")
            if not host or not port:
                self.connected = False
                self.gateway_message = "Gateway transport configured but no host/port provided."
                return False

            try:
                port_value = int(port)
                sock = socket.create_connection((host, port_value), timeout=5)
                self.transport = sock
                self.connected = True
                self.gateway_message = f"Connected to gateway at {host}:{port_value}"
                return True
            except (OSError, ValueError):
                self.connected = False
                self.gateway_message = f"Unable to connect to {host}:{port}"
                return False

        if transport == "serial":
            serial_port = os.getenv("MESH_SERIAL_PORT")
            if not serial_port:
                self.connected = False
                self.gateway_message = "Serial transport selected but no serial port configured."
                return False

            try:
                import serial

                self.transport = serial.Serial(serial_port, 115200, timeout=1)
                self.connected = True
                self.gateway_message = f"Connected to serial gateway {serial_port}"
                return True
            except Exception:
                self.connected = False
                self.gateway_message = f"Unable to open serial port {serial_port}"
                return False

        self.connected = False
        self.gateway_message = "Gateway not configured for this prototype."
        return False

    def handle_message(self, raw_message):
        message = normalize_message(raw_message)
        node_id = message["nodeId"]
        sequence = message["sequence"]
        boot_id = message.get("bootId")

        current = self.nodes.get(node_id)
        if current and current.get("sequence") is not None:
            cur_boot_id = current.get("bootId")
            if boot_id is not None:
                if cur_boot_id == boot_id and sequence <= current["sequence"]:
                    raise ValueError(f"Duplicate or out-of-order sequence for {node_id} (boot {boot_id}): {sequence}")
            else:
                if sequence <= current["sequence"]:
                    raise ValueError(f"Duplicate or out-of-order sequence for {node_id}: {sequence}")

        state = {
            "nodeId": node_id,
            "displayName": node_display_name(node_id),
            "timestamp": message["timestamp"],
            "sequence": sequence,
            "payload": message["payload"],
            "meshId": message.get("meshId"),
            "rssi": message.get("rssi"),
            "rssiSourceNodeId": message.get("rssiSourceNodeId"),
            "hops": message.get("hops"),
            "bootId": boot_id,
            "units": message.get("units"),
            "batteryLevel": message.get("batteryLevel"),
            "firmwareVersion": message.get("firmwareVersion"),
            "role": message.get("role"),
        }
        for key in ("sender", "destination", "ttl", "packetPayload"):
            if message.get(key) is not None:
                state[key] = message[key]

        self.nodes[node_id] = state

        sample = {
            **message["payload"],
            "timestamp": message["timestamp"],
            "sequence": sequence,
        }
        for k in ("bootId", "rssi", "rssiSourceNodeId", "hops", "units"):
            if message.get(k) is not None:
                sample[k] = message[k]
        for key in ("sender", "destination", "ttl", "packetPayload"):
            if message.get(key) is not None:
                sample[key] = message[key]

        self.history.add(node_id, sample)
        self.connected = True
        self.gateway_message = f"Received telemetry from {node_id}"

        event = {
            "type": "telemetry",
            "nodeId": node_id,
            "displayName": state["displayName"],
            "timestamp": message["timestamp"],
            "sequence": sequence,
            "payload": message["payload"],
        }
        for k in ("bootId", "rssi", "rssiSourceNodeId", "hops", "units", "batteryLevel", "firmwareVersion", "role"):
            if message.get(k) is not None:
                event[k] = message[k]
        if "packetPayload" in message:
            event["rssi"] = message.get("rssi")
        for key in ("sender", "destination", "ttl", "packetPayload"):
            if message.get(key) is not None:
                event[key] = message[key]

        return event

    def get_health(self):
        return {
            "status": "ok",
            "gatewayConnected": self.connected,
            "nodes": len(self.nodes),
            "gatewayMessage": self.gateway_message,
        }

    def get_node(self, node_id):
        node = self.nodes.get(node_id)
        if node is None:
            return None
        res = {
            "nodeId": node["nodeId"],
            "displayName": node.get("displayName") or node_display_name(node["nodeId"]),
            "timestamp": node["timestamp"],
            "sequence": node["sequence"],
            "payload": node["payload"],
        }
        for k in (
            "meshId",
            "rssi",
            "rssiSourceNodeId",
            "hops",
            "bootId",
            "units",
            "batteryLevel",
            "firmwareVersion",
            "role",
            "sender",
            "destination",
            "ttl",
            "packetPayload",
        ):
            if node.get(k) is not None:
                res[k] = node[k]
        if "packetPayload" in node:
            res["rssi"] = node.get("rssi")
        return res

    def list_nodes(self):
        return [self.get_node(node_id) for node_id in sorted(self.nodes)]

    def get_history(self, node_id, since=None, limit=100):
        return self.history.get(node_id, since=since, limit=limit)
