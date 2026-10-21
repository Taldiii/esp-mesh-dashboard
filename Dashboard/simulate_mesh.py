#!/usr/bin/env python3
"""Cross-platform interactive mesh telemetry simulator for ESP32 Mesh Dashboard.

Works on Linux, macOS, and Windows. Streams realistic multi-hop ESP-NOW mesh
telemetry into the dashboard so you can test:
  1. Signal Strength (RSSI in dBm, hop count, relay attribution 'via ...')
  2. Automated Insights (baseline collection, >2σ anomaly alerts, trend slope)
  3. Real-time chart with gaps (missing packets rendered as gaps, not zeros)
  4. Station roster & health headline (live, degraded, silent states)
  5. AI Chatbot (grounded conversational analysis via DeepSeek)
  6. Relative sound level (MAX4466 microphone, dBFS) with an injected noise event
"""

import json
import math
import os
import random
import socket
import sys
import threading
import time
import webbrowser

# Add current directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def find_free_port(start_port: int = 8000) -> int:
    for p in range(start_port, start_port + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    raise RuntimeError("No free port found")


def run_simulation():
    # Detect PTY support (Unix) vs TCP socket (Windows / fallback)
    has_pty = hasattr(os, "openpty")

    master_fd = None
    slave_fd = None
    tcp_server_sock = None
    tcp_conn = None

    if has_pty:
        master_fd, slave_fd = os.openpty()
        slave_name = os.ttyname(slave_fd)
        os.environ["MESH_TRANSPORT"] = "serial"
        os.environ["MESH_SERIAL_PORT"] = slave_name
        transport_desc = f"Virtual serial PTY: {slave_name}"
    else:
        # Cross-platform TCP bridge fallback for Windows
        tcp_server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        tcp_server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        tcp_server_sock.bind(("127.0.0.1", 0))
        tcp_server_sock.listen(1)
        tcp_port = tcp_server_sock.getsockname()[1]
        os.environ["MESH_TRANSPORT"] = "tcp"
        os.environ["MESH_HOST"] = "127.0.0.1"
        os.environ["MESH_PORT"] = str(tcp_port)
        transport_desc = f"Local TCP gateway bridge: 127.0.0.1:{tcp_port}"

    from main import app
    import uvicorn

    web_port = find_free_port(8000)
    config = uvicorn.Config(app, host="127.0.0.1", port=web_port, log_level="warning")
    server = uvicorn.Server(config)

    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()

    # Wait for server and TCP client if applicable
    if tcp_server_sock:
        tcp_server_sock.settimeout(10.0)
        try:
            tcp_conn, _ = tcp_server_sock.accept()
        except socket.timeout:
            print("Error: Dashboard TCP client did not connect.")
            return

    def send_line(line_str: str):
        data = (line_str + "\n").encode("utf-8")
        if master_fd is not None:
            os.write(master_fd, data)
        elif tcp_conn is not None:
            tcp_conn.sendall(data)

    print("=" * 65)
    print("  ESP32 MESH TELEMETRY & AI SIMULATOR")
    print("=" * 65)
    print(f"Transport: {transport_desc}")
    print(f"Dashboard running at: http://127.0.0.1:{web_port}")
    print("Opening browser...")
    time.sleep(1.0)
    webbrowser.open(f"http://127.0.0.1:{web_port}")
    print("Streaming simulated mesh nodes:")
    print("  - AA:BB:CC:11:22:01 (node-001): Direct hop, RSSI -58 dBm, battery 88%")
    print("  - AA:BB:CC:11:22:02 (node-002): Relayed via node-001 (2 hops), RSSI -76 dBm")
    print("  - AA:BB:CC:11:22:03 (node-003): Sends 1 packet, then goes silent (stale test)")
    print("-" * 65)
    print("Simulation timeline:")
    print("  • Samples 1-20:  Baseline collection ('Collecting baseline: X/20')")
    print("  • Sample 22:     Injecting anomaly spike -> triggers ANOMALY insight")
    print("  • Samples 23-35: Steady upward ramp -> triggers RISING trend insight")
    print("  • Sample 26:     Loud noise event on mic1.dbfs (-18 dBFS) -> sound anomaly")
    print("  • Chatbot:       Ask questions in the AI ASSISTANT console!")
    print("Press Ctrl+C to stop.")
    print("=" * 65)

    seq_1 = 1
    seq_2 = 1
    boot_1 = "a1b2c3d4e5f60718"
    boot_2 = "b2c3d4e5f6071829"
    boot_3 = "c3d4e5f60718293a"

    # Send initial packet from node-003 so it exists, then go silent
    frame_node3 = {
        "origin": "AA:BB:CC:11:22:03",
        "bootId": boot_3,
        "sequence": 1,
        "hops": 3,
        "rssi": -89,
        "rssiSourceNodeId": "AA:BB:CC:11:22:02",
        "readings": [
            {"sensorId": "ldr1", "channel": "raw", "value": 720.0, "unit": "adc_counts"},
            {"sensorId": "mic1", "channel": "dbfs", "value": -61.2, "unit": "dBFS"},
        ],
    }
    send_line(json.dumps(frame_node3))

    try:
        while True:
            # --- Node 1: Primary sensor node (direct radio hop) ---
            t = seq_1
            # Baseline is ~1200 adc counts with minor jitter, plus temperature & humidity
            temp_1 = 28.5 + 2.0 * math.sin(t / 8.0)
            hum_1 = 62.0 + 5.0 * math.cos(t / 6.0)
            # Relative microphone level: a quiet room floor drifting around -42 dBFS
            sound_1 = -42.0 + 3.5 * math.sin(t / 4.0) + random.uniform(-1.5, 1.5)

            if t == 26:
                # Injected noise event (hand clap / drill) -> insight anomaly on the sound metric
                sound_1 = -18.0
                print(f"[Sample {seq_1:02d}] *NOISE EVENT* on node-001: mic1.dbfs = {sound_1:g} dBFS (Baseline ~-42 dBFS)")

            if t == 22:
                # Injected anomaly spike on LDR
                val_1 = 3950.0
                print(f"[Sample {seq_1:02d}] *INJECTED ANOMALY* on node-001: ldr1.raw = {val_1:g} (Baseline was ~1200)")
            elif 23 <= t <= 35:
                # Rising trend
                val_1 = 1200.0 + (t - 22) * 50.0 + random.uniform(-15, 15)
                print(f"[Sample {seq_1:02d}] Ramping node-001 (rising trend): ldr1.raw = {val_1:.1f}")
            elif t == 12:
                # Intentionally null reading to show packet-gap handling in chart
                val_1 = None
                print(f"[Sample {seq_1:02d}] Missing reading gap on node-001 (chart renders clean gap)")
            else:
                val_1 = 1200.0 + random.uniform(-30, 30)
                if seq_1 <= 20:
                    print(f"[Sample {seq_1:02d}/20] Baseline collecting for node-001: ldr1.raw = {val_1:.1f}")

            readings_1 = [
                {"sensorId": "temp", "channel": "ambient", "value": round(temp_1, 1), "unit": "°C"},
                {"sensorId": "hum", "channel": "relative", "value": round(hum_1, 0), "unit": "%"},
                {"sensorId": "mic1", "channel": "dbfs", "value": round(sound_1, 1), "unit": "dBFS"},
            ]
            if val_1 is not None:
                readings_1.append({"sensorId": "ldr1", "channel": "raw", "value": round(val_1, 1), "unit": "adc_counts"})

            frame_node1 = {
                "origin": "AA:BB:CC:11:22:01",
                "bootId": boot_1,
                "sequence": seq_1,
                "hops": 1,
                "rssi": random.choice([-57, -58, -59, -60]),
                "rssiSourceNodeId": "AA:BB:CC:11:22:01",
                "readings": readings_1,
            }
            send_line(json.dumps(frame_node1))
            seq_1 += 1

            # --- Node 2: Multi-hop sensor node (relayed via node 1) ---
            time.sleep(1.0)
            val_2 = 450.0 + 20.0 * math.sin(seq_2 / 3.0) + random.uniform(-10, 10)
            sound_2 = -55.0 + 2.0 * math.sin(seq_2 / 5.0) + random.uniform(-1.0, 1.0)
            frame_node2 = {
                "origin": "AA:BB:CC:11:22:02",
                "bootId": boot_2,
                "sequence": seq_2,
                "hops": 2,
                "rssi": random.choice([-74, -75, -76, -77]),
                "rssiSourceNodeId": "AA:BB:CC:11:22:01",  # Relayed through Node 1
                "readings": [
                    {"sensorId": "ldr1", "channel": "raw", "value": round(val_2, 1), "unit": "adc_counts"},
                    {"sensorId": "mic1", "channel": "dbfs", "value": round(sound_2, 1), "unit": "dBFS"},
                ],
            }
            send_line(json.dumps(frame_node2))
            seq_2 += 1

            time.sleep(2.0)

    except KeyboardInterrupt:
        print("\nStopping simulator...")
    finally:
        server.should_exit = True
        if master_fd is not None:
            try:
                os.close(master_fd)
                os.close(slave_fd)
            except OSError:
                pass
        if tcp_conn:
            try:
                tcp_conn.close()
            except OSError:
                pass
        if tcp_server_sock:
            try:
                tcp_server_sock.close()
            except OSError:
                pass


if __name__ == "__main__":
    run_simulation()
