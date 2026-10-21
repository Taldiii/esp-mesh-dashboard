# ESP32 Mesh Dashboard Prototype Implementation Plan

## Goal

Build the smallest complete prototype that can:

1. Connect to an ESP32 mesh gateway.
2. Receive messages from an ESP32 node.
3. Validate and normalize the messages.
4. Store recent telemetry for graphs and trend views.
5. Display the latest values and historical data in a browser dashboard.
6. Show connection and message status.

The prototype will initially retain a bounded in-memory history, but it will not persist data across process restarts or manage multiple mesh networks.

## Architecture

```text
ESP32 Node / Gateway
        |
        | TCP, serial, or configured mesh gateway transport
        v
Python Receiver
  - transport adapter
  - message parser
  - validation
  - in-memory node state
  - bounded historical telemetry buffer
  - WebSocket or SSE endpoint
        |
        v
Browser Dashboard
  - connection status
  - node status
  - latest telemetry
  - historical graph
  - message log
```

The browser should communicate with the Python receiver, not directly with the ESP32 nodes.

## Assumptions

- The ESP32 gateway can send a stream of JSON or line-delimited messages to a computer.
- The dashboard is running on the same machine as the receiver or on a network reachable by the gateway.
- The first prototype uses one gateway and one node.
- The receiver keeps the latest message for each node in memory.
- A WebSocket connection is used for real-time updates.

If the firmware exposes only radio traffic and no TCP/serial bridge, add a small ESP32 gateway that forwards received mesh messages over TCP.

## Project Structure

```text
Dashboard/
├── main.py
├── receiver.py
├── mesh_protocol.py
├── history.py
├── frontend/
│   ├── dashboard.html
│   ├── styles.css
│   └── app.js
├── tests/
│   ├── test_history.py
│   └── test_receiver.py
├── requirements.txt
├── .env.example
├── run.bat
└── IMPLEMENTATION_PLAN.md
```

The final structure may be split into a backend and frontend folder if the repository grows, but the prototype should remain easy to run from one directory.

## Phase 0 — Confirm the Firmware Contract

### Purpose

Determine the exact message produced by the ESP-Mesh-Lite firmware and the transport available to the dashboard.

### Required decisions

1. Determine whether the node sends data through:
   - TCP over Wi-Fi.
   - USB serial.
   - MQTT.
   - A separate gateway node.
2. Confirm the message format emitted by ESP-Mesh-Lite.
3. Confirm whether the firmware supports a custom sender or only native mesh packets.
4. Decide whether the gateway sends JSON, newline-delimited text, or binary frames.
5. Define a stable node identifier and mesh identifier.

### Deliverable

A short firmware contract, for example:

```json
{
  "nodeId": "node-001",
  "meshId": "prototype",
  "timestamp": "2026-10-07T10:15:30Z",
  "sequence": 42,
  "payload": {
    "temperature": 24.8,
    "humidity": 48
  }
}
```

### Verification

- Send one known message from the ESP32.
- Capture it in a serial monitor, TCP debugger, or gateway log.
- Confirm its exact bytes and delimiters.

## Phase 1 — Create the Python Receiver

### Purpose

Create a small process that connects to the mesh gateway and receives messages.

### Implementation tasks

1. Add a configuration object for the transport endpoint.
2. Create a transport adapter that connects to TCP, serial, or a configured input stream.
3. Implement a read loop that waits for complete messages.
4. Handle reconnects and connection failures.
5. Add a timeout for inactive connections.
6. Keep the latest message for every node in memory.

### Suggested modules

- `receiver.py`: connection, receive loop, reconnect, and state.
- `mesh_protocol.py`: message parsing and validation.
- `main.py`: FastAPI application and WebSocket endpoint.

### Receive behavior

The receiver should:

1. Connect to the gateway.
2. Read a complete frame.
3. Parse it into a structured object.
4. Validate the required fields.
5. Update the in-memory node state.
6. Publish the event to connected browser clients.

## Phase 2 — Define and Validate the Message Schema

### Purpose

Prevent malformed or unexpected data from reaching the dashboard.

### Required fields

- `nodeId`: stable identifier.
- `timestamp`: ISO 8601 timestamp.
- `sequence`: integer used to detect duplicate or out-of-order messages.
- `payload`: sensor data.

### Optional fields

- `meshId`
- `rssi`
- `batteryLevel`
- `firmwareVersion`
- `role`

### Validation rules

- The node ID must be non-empty.
- The timestamp must be valid.
- The sequence must be a non-negative integer.
- Sensor values must be numbers within the expected range.
- Unknown fields may be preserved in the raw message, but they should not break parsing.

### Test cases

- Valid JSON message.
- Invalid JSON message.
- Missing node ID.
- Invalid timestamp.
- Duplicate sequence number.
- Missing payload.
- Malformed numeric sensor value.

## Phase 3 — Expose Data to the Browser

### Purpose

Provide real-time data through a simple API.

### API endpoints

#### GET `/health`

Returns:

```json
{
  "status": "ok",
  "gatewayConnected": true,
  "nodes": 1
}
```

#### GET `/nodes`

Returns the current node state.

#### GET `/nodes/{nodeId}`

Returns the latest message for one node.

#### GET `/nodes/{nodeId}/history`

Returns the most recent telemetry samples for a node. The response can accept a `since` timestamp or a `limit` query parameter.

```json
{
  "nodeId": "node-001",
  "samples": [
    {
      "timestamp": "2026-10-07T10:15:30Z",
      "temperature": 24.8,
      "humidity": 48,
      "sequence": 42
    }
  ]
}
```

#### WebSocket `/live`

Sends a message when a new valid telemetry event is received.

```json
{
  "type": "telemetry",
  "nodeId": "node-001",
  "timestamp": "2026-10-07T10:15:30Z",
  "payload": {
    "temperature": 24.8,
    "humidity": 48
  }
}
```

## Phase 4 — Build the Dashboard

### Purpose

Show that the backend receives and forwards data.

### Initial UI

- Header with connection status.
- Node name and node ID.
- Latest temperature.
- Latest humidity.
- Timestamp.
- Sequence number.
- A line chart for temperature and humidity.
- A recent message log.
- Reconnect message when the gateway disconnects.

### History behavior

- Keep a bounded history buffer per node, for example the latest 1,000 samples.
- Store normalized telemetry samples, not raw messages.
- Add the timestamp and sequence number to every sample.
- Expose the stored history through `/nodes/{nodeId}/history`.
- Render only the most recent graph range on the dashboard.
- Make the retention limit configurable through environment variables.

### UI behavior

- Use the WebSocket connection to update the latest values.
- Fetch history once when a node is selected.
- Append new samples to the graph when the WebSocket receives telemetry.
- Show a disconnected placeholder when the socket is not connected.
- Keep history in the receiver for the current process; do not persist it across restarts in the first version.

### Suggested files

- `frontend/dashboard.html`: page structure.
- `frontend/styles.css`: responsive dashboard style.
- `frontend/app.js`: WebSocket client and rendering.

## Phase 5 — Add Automated Tests

### Backend tests

Use Python and Pytest to test:

- Successful message parsing.
- Invalid message rejection.
- Duplicate sequence handling.
- Latest value replacement.
- Node state creation.
- History retention limit.
- History retrieval by node.
- Graph data formatting.
- Reconnect behavior where practical.

### Browser smoke test

Use Playwright or a browser-based check to verify that:

1. The dashboard loads.
2. The connection indicator updates.
3. A simulated telemetry event is displayed.
4. The dashboard handles a missing gateway connection.

The test should exercise the actual WebSocket endpoint rather than a mock-only response.

## Phase 6 — Run the Prototype

### Startup

On Windows, double-click `run.bat`. It creates a local virtual environment if needed,
installs the required packages, and starts the server.

Alternatively, create a virtual environment and install dependencies manually:

```bash
python -m venv .venv
.venv\Scripts\activate
python -m pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Open the dashboard at:

```text
http://localhost:8000
```

### Required runtime configuration

Example environment variables:

```text
MESH_TRANSPORT=tcp
MESH_HOST=192.168.1.100
MESH_PORT=8080
MESH_NODE_ID=node-001
WEBSOCKET_HOST=0.0.0.0
WEBSOCKET_PORT=8000
```

For a USB serial setup, use a serial path such as:

```text
MESH_TRANSPORT=serial
MESH_SERIAL_PORT=COM3
```

## Phase 7 — Add the First Node

### Step-by-step validation

1. Start the Python receiver.
2. Connect the ESP32 gateway.
3. Send one telemetry message.
4. Confirm the receiver logs the message.
5. Confirm the browser receives the message.
6. Confirm the displayed node ID and sensor values match the firmware data.
7. Toggle the connection by unplugging or restarting the gateway.
8. Confirm the UI reports disconnected and reconnects automatically.

### Success criteria

The prototype is working when:

- One ESP32 node can send telemetry.
- The Python receiver receives it.
- The browser displays the latest telemetry.
- The connection status is visible.
- Malformed messages do not crash the receiver.

## Recommended Implementation Order

1. Confirm the firmware data format and transport.
2. Create the simplest TCP or serial reader.
3. Parse one known JSON message.
4. Add in-memory node state.
5. Create the health endpoint.
6. Add the WebSocket endpoint.
7. Create the browser dashboard.
8. Add duplicate and malformed-message handling.
9. Add tests.
10. Connect the physical ESP32 node and verify end-to-end.

## Scope Boundaries

Do not include these until the first end-to-end connection and history feature are working:

- Durable database persistence.
- Authentication.
- Multiple mesh networks.
- MQTT broker.
- Alerts.
- Automatic node discovery.
- TLS.
- Docker.
- User accounts.
- Device provisioning.

## Risks and Decisions to Resolve

| Risk | Resolution |
|---|---|
| ESP-Mesh-Lite cannot expose a TCP/serial stream | Add a gateway ESP32 that forwards mesh messages |
| Firmware output is not JSON | Add a small decoder for the firmware’s actual format |
| Mesh messages are fragmented | Implement a frame parser or line delimiter |
| Browser cannot connect to the mesh | Keep the browser connected only to the Python receiver |
| Gateway disconnects | Add reconnect and status handling |
| Multiple nodes send messages simultaneously | Per-node state and synchronized receiver loop |

## Definition of Done

The prototype is complete when:

- A real ESP32 node can publish one telemetry message.
- The Python receiver connects without manual restarts.
- The receiver validates and displays the message.
- The dashboard shows the connection state.
- The dashboard updates when the node publishes new data.
- The receiver handles invalid messages without stopping.
- The project has at least one automated parser test and one browser smoke test.

## Phase 8 — Add the Sound Level Metric (MAX4466)

### Purpose

Report the noise environment of each station as a third live measurement, so the dashboard, the insight engine and the AI assistant can see it next to temperature and humidity.

### Hardware

| MAX4466 module | ESP32 dev board | Note |
|---|---|---|
| VCC | 3V3 | Never 5 V: the output sits at VCC/2, so 5 V raises the idle level above the ADC range |
| GND | GND | Common ground with the node |
| OUT | GPIO34 (ADC1_CH6) | GPIO34–39 are input-only ADC1 pins; ADC2 is unusable while Wi-Fi is on |

Set the on-board gain pot so the loudest expected sound still peaks below full scale. Clipping destroys the level information.

### Metric contract

| Field | Value |
|---|---|
| Payload key | `S` (compact firmware JSON), or any key whose last segment is `s`, `db`, `dbfs`, `spl`, or that contains `sound`, `mic`, `noise`, `audio` |
| Unit | `dBFS` — relative to ADC full scale |
| Range | `-90` (silence floor) to `0` (signal spanning the whole ADC range) |
| Display | "Sound level", 1 decimal place |

Sound is a **relative** level, not dB SPL. A MAX4466 board has no acoustic reference and its gain is a trim pot, so values are only comparable across windows from the same node with the same pot position.

$$
L_{\mathrm{dBFS}} = 20 \log_{10}\left(\frac{\mathrm{RMS}_{\mathrm{AC}}}{2048}\right)
$$

where:

- $\mathrm{RMS}_{\mathrm{AC}}$ = RMS of the signal after removing its DC bias, in ADC counts.
- $2048$ = half of the 12-bit ADC range, the reference amplitude.

A rise of 6 dB is roughly double the signal amplitude, or four times the acoustic power.

### Firmware

`SoundSensor` samples one window (default 50 ms) and derives the AC RMS from a running sum and sum of squares, so no sample buffer is needed:

1. Accumulate `sum` and `sumSquares` over the window.
2. `mean = sum / N` is the DC bias of the module; `meanSquare = sumSquares / N`.
3. `acRms = sqrt(max(0, meanSquare - mean^2))`.
4. Convert to dBFS, clamp to `[-90, 0]`, emit `{'S', level}`.

Payload example at a 3 s report interval:

```json
{"L":1180,"T":26.4,"H":61,"P":100850,"S":-38.5}
```

### Dashboard behaviour

- Metric strip: a "SOUND LEVEL" card next to temperature and humidity.
- Trend chart: the `SERIES` selector defaults to `AUTO (TOP 2)`; picking "Sound level" plots that metric alone on the left axis with a distinct colour.
- Compare Nodes: the measurement dropdown lists Sound level for cross-station comparison.
- Automated Insights: trend and >2σ anomaly rules run on the sound metric with no extra wiring.
- Event log: sound appears in the per-sample summary line.
- AI assistant: grounding gains a sound block (latest, peak, baseline mean, noise-event flag) and the prompt forbids presenting it as a calibrated dB SPL reading.

### What it is for

- Noise events: a clap, door, alarm or machine start shows up as a spike above the node's own baseline.
- Quiet-hours and occupancy proxy: sustained level changes indicate activity near the station.
- Cross-metric correlation: an air conditioner raises noise and changes temperature at the same time.
- Enclosure tampering: a sudden loud transient near the node.

Absolute noise compliance (for example a 55 dBA night limit) needs a calibrated meter, not a MAX4466.

### Verification

```bash
# backend (skip the POSIX-only PTY test on Windows)
python -m pytest tests -q --ignore=tests/test_serial_pty_e2e.py

# firmware
pio run -d mesh-node

# dashboard against simulated nodes (injects a noise event at sample 26)
python simulate_mesh.py
```

