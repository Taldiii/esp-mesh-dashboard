import asyncio
import json
import pytest
import httpx
from fastapi.testclient import TestClient

from ai_assistant import calculate_dew_point, build_grounding_context, ask_mesh_ai, get_ai_config
from main import app, receiver
from receiver import MeshReceiver


def test_calculate_dew_point():
    # 40°C with 30% RH (friend's example) -> dew point should be ~19.1°C
    dp = calculate_dew_point(40.0, 30.0)
    assert dp is not None
    assert 19.0 <= dp <= 19.2

    # High moisture: 25°C with 90% RH
    dp_high = calculate_dew_point(25.0, 90.0)
    assert dp_high is not None
    assert 23.0 <= dp_high <= 23.5

    # Invalid / non-finite inputs
    assert calculate_dew_point(float("nan"), 50.0) is None
    assert calculate_dew_point(20.0, -10.0) is None
    assert calculate_dew_point(20.0, 150.0) is None


def test_build_grounding_context():
    rx = MeshReceiver()
    rx.handle_message({
        "nodeId": "node-weather",
        "timestamp": "2026-10-19T10:00:00Z",
        "sequence": 1,
        "rssi": -65.0,
        "hops": 1,
        "batteryLevel": 92.0,
        "payload": {"temperature": 40.0, "humidity": 30.0},
        "units": {"temperature": "°C", "humidity": "%"},
    })

    context = build_grounding_context(rx, selected_node_id="node-weather")
    assert "node-weather" in context["summary"]
    assert "40" in context["summary"]
    assert "Dew Point" in context["summary"]
    assert context["selectedNode"] is not None
    assert context["selectedNode"]["weatherAnalysis"]["dewPointC"] is not None


def test_ask_mesh_ai_unconfigured(monkeypatch):
    monkeypatch.setenv("AI_API_KEY", "")
    res = asyncio.run(ask_mesh_ai(message="Hello", receiver=receiver))
    assert res["configured"] is False
    assert "not configured" in res["reply"].lower()


def test_ask_mesh_ai_mocked_success(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "deepseek")
    monkeypatch.setenv("AI_API_KEY", "test_mock_key")
    monkeypatch.setenv("AI_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("AI_MODEL", "deepseek-chat")

    fake_response = {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "Mesh network is nominal."},
                "finish_reason": "stop",
            }
        ],
    }

    def mock_handler(request: httpx.Request):
        assert request.headers["authorization"] == "Bearer test_mock_key"
        body = json.loads(request.content.decode("utf-8"))
        assert body["model"] == "deepseek-chat"
        assert len(body["messages"]) >= 2
        return httpx.Response(200, json=fake_response)

    transport = httpx.MockTransport(mock_handler)
    async def _run():
        async with httpx.AsyncClient(transport=transport) as mock_client:
            return await ask_mesh_ai(
                message="Check status",
                history=[{"role": "user", "content": "hi"}],
                selected_node_id=None,
                receiver=receiver,
                client=mock_client,
            )
    res = asyncio.run(_run())
    assert res["configured"] is True
    assert res["reply"] == "Mesh network is nominal."
    assert res["model"] == "deepseek-chat"


def test_ask_mesh_ai_opencode_deepseek_flash_chat_completions(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "opencode")
    monkeypatch.setenv("AI_API_KEY", "test_opencode_key")
    monkeypatch.delenv("AI_BASE_URL", raising=False)
    monkeypatch.delenv("AI_MODEL", raising=False)

    def mock_handler(request: httpx.Request):
        assert str(request.url) == "https://opencode.ai/inference/openai/v1/chat/completions"
        body = json.loads(request.content.decode("utf-8"))
        assert body["model"] == "deepseek-v4.1-flash-free"
        assert body["max_tokens"] == 350
        assert any(item["role"] == "system" for item in body["messages"])
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "OpenCode DeepSeek Flash is working.",
                        }
                    }
                ]
            },
        )

    transport = httpx.MockTransport(mock_handler)

    async def _run():
        async with httpx.AsyncClient(transport=transport) as mock_client:
            return await ask_mesh_ai(
                message="Check status",
                receiver=receiver,
                client=mock_client,
            )

    result = asyncio.run(_run())
    assert result["configured"] is True
    assert result["reply"] == "OpenCode DeepSeek Flash is working."
    assert result["model"] == "deepseek-v4.1-flash-free"


def test_api_chat_and_status_endpoints(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "deepseek")
    monkeypatch.setenv("AI_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("AI_MODEL", "deepseek-chat")
    client = TestClient(app)

    # Status check
    res_status = client.get("/api/ai/status")
    assert res_status.status_code == 200
    assert "configured" in res_status.json()

    # Empty message rejection
    res_empty = client.post("/api/chat", json={"message": "   "})
    assert res_empty.status_code == 400

    # Mocked post
    fake_response = {
        "choices": [
            {
                "message": {"role": "assistant", "content": "Rain is improbable at 30% RH."},
            }
        ],
    }

    def mock_handler(request: httpx.Request):
        return httpx.Response(200, json=fake_response)

    # Use monkeypatch on httpx.AsyncClient to test endpoint without external network
    real_async_client = httpx.AsyncClient

    def mocked_async_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(mock_handler)
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr("httpx.AsyncClient", mocked_async_client)
    monkeypatch.setenv("AI_API_KEY", "test_mock_key")

    res_chat = client.post("/api/chat", json={"message": "Will it rain?", "nodeId": "node-001"})
    assert res_chat.status_code == 200
    data = res_chat.json()
    assert data["configured"] is True
    assert "Rain is improbable" in data["reply"]
