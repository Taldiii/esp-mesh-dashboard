"""Sound level metric (MAX4466 microphone) end-to-end through the dashboard contract."""

import json

import pytest
from fastapi.testclient import TestClient

from ai_assistant import analyse_sound_level, build_grounding_context
from insights import calculate_insights
from main import app, receiver
from mesh_protocol import convert_gateway_frame, normalize_message
from receiver import MeshReceiver


NODE = "AA:BB:CC:11:22:01"

SOUND_FRAME = {
    "origin": NODE,
    "bootId": "0123456789abcdef",
    "sequence": 1,
    "hops": 1,
    "rssi": -58,
    "rssiSourceNodeId": NODE,
    "readings": [
        {"sensorId": "temp", "channel": "ambient", "value": 26.4, "unit": "°C"},
        {"sensorId": "hum", "channel": "relative", "value": 61.0, "unit": "%"},
        {"sensorId": "mic1", "channel": "dbfs", "value": -38.5, "unit": "dBFS"},
    ],
}


def test_gateway_frame_carries_the_sound_reading():
    envelope = convert_gateway_frame(SOUND_FRAME)

    assert envelope["payload"]["mic1.dbfs"] == -38.5
    assert envelope["units"]["mic1.dbfs"] == "dBFS"
    assert envelope["payload"]["temp.ambient"] == 26.4


def test_compact_firmware_payload_exposes_the_sound_code():
    """The node ships getReadingsJson() output, so the key is the single letter S."""
    packet = {
        "sender": NODE,
        "rssi": -58,
        "origin": NODE,
        "destination": "FF:FF:FF:FF:FF:FF",
        "sequence": 9,
        "ttl": 5,
        "hops": 1,
        "payload": '{"L":1180,"T":26.4,"H":61,"P":100850,"S":-38.5}',
    }

    envelope = normalize_message(json.dumps(packet))

    assert envelope["payload"]["S"] == -38.5
    assert envelope["payload"]["T"] == 26.4


def test_receiver_stores_sound_in_state_and_history():
    rx = MeshReceiver()
    event = rx.handle_message(SOUND_FRAME)

    assert event["payload"]["mic1.dbfs"] == -38.5
    node = rx.get_node(NODE)
    assert node["payload"]["mic1.dbfs"] == -38.5
    assert node["units"]["mic1.dbfs"] == "dBFS"

    history = rx.get_history(NODE)
    assert history[0]["mic1.dbfs"] == -38.5
    assert history[0]["units"] == {
        "temp.ambient": "°C",
        "hum.relative": "%",
        "mic1.dbfs": "dBFS",
    }


def test_sound_metric_gets_trend_and_anomaly_insights():
    units = {"mic1.dbfs": "dBFS"}
    rising = [
        {"timestamp": f"2026-10-22T10:{i:02d}:00Z", "mic1.dbfs": -50.0, "units": units}
        for i in range(10)
    ] + [
        {"timestamp": f"2026-10-22T10:{i + 10:02d}:00Z", "mic1.dbfs": -40.0, "units": units}
        for i in range(10)
    ]
    trend = [i for i in calculate_insights(NODE, rising)["insights"] if i["metric"] == "mic1.dbfs"]
    assert any(i["kind"] == "trend" and i["direction"] == "rising" and i["delta"] == 10.0 for i in trend)
    assert any("dBFS" in i["message"] for i in trend)

    spike = [
        {"timestamp": f"2026-10-22T11:{i:02d}:00Z", "mic1.dbfs": -42.0, "units": units}
        for i in range(20)
    ] + [{"timestamp": "2026-10-22T11:20:00Z", "mic1.dbfs": -18.0, "units": units}]
    anomalies = [i for i in calculate_insights(NODE, spike)["insights"] if i["kind"] == "anomaly"]
    assert len(anomalies) == 1
    assert anomalies[0]["metric"] == "mic1.dbfs"
    assert anomalies[0]["value"] == -18.0
    assert anomalies[0]["unit"] == "dBFS"
    assert "unusually high" in anomalies[0]["message"]


def test_api_surfaces_the_sound_metric():
    client = TestClient(app)
    receiver.nodes.clear()
    receiver.history.clear()

    receiver.handle_message(SOUND_FRAME)

    node = client.get(f"/nodes/{NODE}").json()
    assert node["payload"]["mic1.dbfs"] == -38.5
    assert node["units"]["mic1.dbfs"] == "dBFS"

    insights = client.get(f"/nodes/{NODE}/insights").json()
    assert insights["sampleCount"] == 1
    assert insights["insights"] == []


def test_analyse_sound_level_flags_a_noise_event():
    history = [
        {"timestamp": f"2026-10-22T12:{i:02d}:00Z", "mic1.dbfs": -40.0} for i in range(20)
    ]
    analysis = analyse_sound_level({"mic1.dbfs": -22.0}, history + [{"mic1.dbfs": -22.0}])

    assert analysis["metric"] == "mic1.dbfs"
    assert analysis["latestRelativeLevel"] == -22.0
    assert analysis["baselineMean"] == -40.0
    assert analysis["deltaFromBaseline"] == 18.0
    assert analysis["noiseEventDetected"] is True
    assert analysis["unit"] == "dBFS"


def test_analyse_sound_level_ignores_nodes_without_a_microphone():
    assert analyse_sound_level({"temp.ambient": 26.4}, []) is None


def test_ai_grounding_includes_the_sound_summary():
    rx = MeshReceiver()
    rx.handle_message(SOUND_FRAME)

    grounding = build_grounding_context(rx, NODE)

    assert grounding["selectedNode"]["soundAnalysis"]["latestRelativeLevel"] == -38.5
    assert "Sound level for" in grounding["summary"]
    assert "dBFS" in grounding["summary"]
