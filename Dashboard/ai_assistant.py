import logging
import math
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import httpx

from insights import calculate_insights

logger = logging.getLogger("esp_mesh_dashboard.ai")

SOUND_KEY_CODES = {"s", "db", "dbfs", "spl"}
SOUND_KEY_HINTS = ("sound", "mic", "noise", "audio")


def calculate_dew_point(temperature: float, humidity: float) -> Optional[float]:
    """Calculates dew point temperature in Celsius using the Magnus-Tetens formula."""
    if not (math.isfinite(temperature) and math.isfinite(humidity)):
        return None
    if humidity <= 0 or humidity > 100:
        return None
    a = 17.27
    b = 237.7
    try:
        alpha = ((a * temperature) / (b + temperature)) + math.log(humidity / 100.0)
        dew_point = (b * alpha) / (a - alpha)
        return round(dew_point, 2)
    except (ValueError, ZeroDivisionError):
        return None


def _is_sound_key(key: str) -> bool:
    """True for metrics that come from the microphone rather than a climate sensor."""
    code = re.split(r"[._\s-]", key)[-1].lower()
    if code in SOUND_KEY_CODES:
        return True
    lower = key.lower()
    return any(hint in lower for hint in SOUND_KEY_HINTS)


def analyse_sound_level(payload: Dict[str, Any], history: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Summarise the relative noise level: latest value, baseline mean, peak, spike flag.

    MAX4466 boards have no absolute acoustic reference, so every number here is a
    relative dBFS level and only comparable within the same node and gain setting.
    """
    key = next((candidate for candidate in payload if _is_sound_key(candidate)), None)
    if key is None:
        return None

    latest = payload.get(key)
    if isinstance(latest, bool) or not isinstance(latest, (int, float)) or not math.isfinite(latest):
        return None

    values: List[float] = []
    for sample in history:
        value = sample.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            continue
        values.append(float(value))

    baseline = values[-101:-1] if len(values) > 1 else []
    mean = round(sum(baseline) / len(baseline), 1) if baseline else None
    peak = round(max(values), 1) if values else None
    delta = round(float(latest) - mean, 1) if mean is not None else None

    return {
        "metric": key,
        "unit": "dBFS",
        "calibration": "relative only (MAX4466, no absolute acoustic reference)",
        "latestRelativeLevel": round(float(latest), 1),
        "baselineMean": mean,
        "peak": peak,
        "baselineSamples": len(baseline),
        "deltaFromBaseline": delta,
        "noiseEventDetected": bool(delta is not None and delta >= 6.0),
    }


def get_ai_config() -> Dict[str, Any]:
    provider = os.getenv("AI_PROVIDER", "deepseek").strip().lower()
    api_key = os.getenv("AI_API_KEY", "").strip()
    default_base_url = (
        "https://opencode.ai/inference/openai/v1"
        if provider.startswith("opencode")
        else "https://api.deepseek.com"
    )
    default_model = (
        "deepseek-v4.1-flash-free" if provider.startswith("opencode") else "deepseek-chat"
    )
    base_url = os.getenv("AI_BASE_URL", default_base_url).strip().rstrip("/")
    model = os.getenv("AI_MODEL", default_model).strip()
    if provider.startswith("opencode"):
        default_format = (
            "chat_completions"
            if model.endswith("-free")
            else "responses"
        )
    else:
        default_format = "chat_completions"
    api_format = os.getenv("AI_API_FORMAT", "").strip().lower() or default_format
    if api_format not in ("chat_completions", "responses"):
        api_format = default_format
    # OpenCode gateways route on a stable session id; without it they answer 400 MissingSessionID.
    session_id = os.getenv("AI_SESSION_ID", "").strip() or str(
        uuid.uuid5(uuid.NAMESPACE_DNS, "esp-mesh-dashboard.local")
    )
    return {
        "api_key": api_key,
        "base_url": base_url,
        "model": model,
        "provider": provider,
        "api_format": api_format,
        "session_id": session_id,
        "configured": bool(api_key),
    }


def build_grounding_context(receiver: Any, selected_node_id: Optional[str] = None) -> Dict[str, Any]:
    health = receiver.get_health()
    all_nodes = receiver.list_nodes()

    summary_lines = []
    summary_lines.append(f"Gateway Status: {'CONNECTED' if health.get('gatewayConnected') else 'OFFLINE'}")
    summary_lines.append(f"Gateway Info: {health.get('gatewayMessage', 'N/A')}")
    summary_lines.append(f"Reporting Stations: {len(all_nodes)}")

    nodes_context = []
    now = datetime.now(timezone.utc)
    labels = {n.get("nodeId"): (n.get("displayName") or n.get("nodeId")) for n in all_nodes}

    for node in all_nodes:
        nid = node.get("nodeId", "unknown")
        label = node.get("displayName") or nid
        seq = node.get("sequence")
        rssi = node.get("rssi")
        rssi_src = node.get("rssiSourceNodeId")
        hops = node.get("hops")
        bat = node.get("batteryLevel")
        payload = node.get("payload", {})
        units = node.get("units", {})
        ts_str = node.get("timestamp")

        age_sec = None
        if ts_str:
            try:
                ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                age_sec = round((now - ts).total_seconds(), 1)
            except Exception:
                pass

        node_info = {
            "nodeId": nid,
            "displayName": label,
            "sequence": seq,
            "lastSeenAgeSec": age_sec,
            "rssi": f"{rssi} dBm" if rssi is not None else "unavailable",
            "rssiSource": rssi_src,
            "hops": hops,
            "battery": f"{bat}%" if bat is not None else "unavailable",
            "readings": {k: f"{v} {units.get(k, '')}".strip() for k, v in payload.items()},
        }
        nodes_context.append(node_info)

        readings_str = ", ".join(f"{k}: {v}" for k, v in node_info["readings"].items()) or "no readings"
        summary_lines.append(
            f"- Station {label} ({nid}): seq={seq}, age={age_sec}s, RSSI={node_info['rssi']} "
            f"(via {labels.get(rssi_src, rssi_src) or label}, {hops or 1} hop(s)), "
            f"battery={node_info['battery']}, readings=[{readings_str}]"
        )

    selected_context = None
    if selected_node_id:
        selected_node = receiver.get_node(selected_node_id)
        if selected_node:
            history = receiver.get_history(selected_node_id, limit=60)
            insights_res = calculate_insights(selected_node_id, history, node=selected_node)
            payload = selected_node.get("payload", {})

            # Weather / dew point check if temp and humidity exist (including dotted keys like temp.ambient)
            temp = None
            hum = None
            for k, v in payload.items():
                k_lower = k.lower()
                if ("temp" in k_lower or "temperature" in k_lower) and temp is None:
                    temp = v
                elif ("hum" in k_lower or "humidity" in k_lower) and hum is None:
                    hum = v
            weather_analysis = None
            if temp is not None and hum is not None and isinstance(temp, (int, float)) and isinstance(hum, (int, float)):
                dew_point = calculate_dew_point(float(temp), float(hum))
                if dew_point is not None:
                    depression = round(float(temp) - dew_point, 2)
                    if float(hum) >= 85 and depression <= 2.5:
                        rain_assessment = "High moisture / near saturation; fog or precipitation likely if rising or cooled."
                    elif float(temp) >= 35 and float(hum) <= 35:
                        rain_assessment = "Hot, arid/dry condition; precipitation highly improbable without severe cooling or weather front."
                    elif float(hum) >= 60:
                        rain_assessment = "Moderate to elevated humidity; rain depends on cloud cover and atmospheric pressure drop."
                    else:
                        rain_assessment = "Dry to comfortable atmospheric levels; rain unlikely under stable pressure."

                    weather_analysis = {
                        "temperatureC": float(temp),
                        "relativeHumidityPercent": float(hum),
                        "dewPointC": dew_point,
                        "dewPointDepressionC": depression,
                        "assessment": rain_assessment,
                    }

            sound_analysis = analyse_sound_level(payload, history)

            selected_context = {
                "nodeId": selected_node_id,
                "displayName": selected_node.get("displayName") or selected_node_id,
                "latestPayload": payload,
                "sampleCount": len(history),
                "weatherAnalysis": weather_analysis,
                "soundAnalysis": sound_analysis,
                "statisticalInsights": insights_res.get("insights", []),
            }

            if sound_analysis:
                baseline = sound_analysis["baselineMean"]
                summary_lines.append(
                    f"\nSound level for {selected_context['displayName']} "
                    f"(relative {sound_analysis['unit']}, uncalibrated MAX4466):\n"
                    f"  Latest: {sound_analysis['latestRelativeLevel']} dBFS, "
                    f"peak {sound_analysis['peak']} dBFS over "
                    f"{sound_analysis['baselineSamples'] + 1} sample(s)"
                    + (f", baseline mean {baseline} dBFS" if baseline is not None else "")
                    + (
                        f"\n  Noise event: latest is {sound_analysis['deltaFromBaseline']} dB above baseline"
                        if sound_analysis["noiseEventDetected"]
                        else ""
                    )
                )

            if weather_analysis:
                summary_lines.append(
                    f"\nDetailed Physical Analysis for {selected_context['displayName']}:\n"
                    f"  Temperature: {weather_analysis['temperatureC']} °C, Humidity: {weather_analysis['relativeHumidityPercent']} %RH\n"
                    f"  Dew Point: {weather_analysis['dewPointC']} °C (Depression: {weather_analysis['dewPointDepressionC']} °C)\n"
                    f"  Rain/Condensation Assessment: {weather_analysis['assessment']}"
                )

            if insights_res.get("insights"):
                summary_lines.append("\nStatistical Insights:")
                for ins in insights_res["insights"]:
                    summary_lines.append(f"  [{ins.get('kind', '').upper()}] {ins.get('message', '')}")

    return {
        "summary": "\n".join(summary_lines),
        "gateway": health,
        "nodes": nodes_context,
        "selectedNode": selected_context,
    }


def build_system_prompt(grounding: Dict[str, Any]) -> str:
    return (
        "You are the ESP32 Mesh Telemetry AI Assistant, an expert IoT monitoring engineer "
        "and environmental sensor specialist.\n\n"
        "LIVE MESH NETWORK AND SENSOR CONTEXT:\n"
        f"{grounding.get('summary', 'No telemetry available.')}\n\n"
        "GUIDELINES FOR YOUR ANSWERS:\n"
        "1. Ground all answers strictly in the real-time telemetry and network context provided above.\n"
        "2. Refer directly to station IDs (e.g. node-001, AA:BB:CC:DD:EE:FF), sequence numbers, RSSI in dBm, and hop count when discussing connectivity or hardware.\n"
        "3. When asked about weather or rain (e.g., 'Will it rain?', 'What does 40C and 30% humidity mean?'), explain the atmospheric physics truthfully:\n"
        "   - Use temperature, humidity, and dew point.\n"
        "   - Note that rain requires cooling near dew point and cloud condensation nuclei; hot, low-humidity air (like 40°C with 30% RH) has a large dew point depression (~19°C dew point), making rain very unlikely under stable conditions.\n"
        "   - Note that true barometric weather forecasting requires a barometric pressure sensor (e.g. BMP280/BME280).\n"
        "4. Sound readings come from an uncalibrated MAX4466 microphone and are RELATIVE levels in dBFS "
        "(0 dBFS = ADC full scale, -90 dBFS = silence). Never call them dB SPL or a calibrated noise level. "
        "Interpret them against the same station's own baseline: +6 dB is roughly double the signal amplitude "
        "(four times the acoustic power), so use them to flag noise events, machinery activity or a sudden quiet. "
        "If the user asks what the sound data is for, answer in that operational sense, not as a decibel meter.\n"
        "5. Be extremely brief. Default to one to three short sentences (under 45 words). "
        "A full telemetry dump is forbidden unless the user explicitly asks for a report, "
        "an audit, or a comparison.\n"
        "6. Greetings, thanks and small talk get a single short line. Do not recite station "
        "readings, statistics or trends unless the question actually needs them.\n"
        "7. Name only the stations relevant to the question; never list every station by default.\n"
        "8. Provide output in clear plain text without markdown formatting (no asterisks, bolding, hashes, or backticks) so it renders cleanly in an instrument terminal."
    )


async def ask_mesh_ai(
    message: str,
    history: Optional[List[Dict[str, str]]] = None,
    selected_node_id: Optional[str] = None,
    receiver: Any = None,
    client: Optional[httpx.AsyncClient] = None,
) -> Dict[str, Any]:
    config = get_ai_config()
    grounding = build_grounding_context(receiver, selected_node_id) if receiver else {"summary": "Receiver offline."}

    if not config["configured"]:
        return {
            "configured": False,
            "reply": (
                "AI Assistant is not configured. Add your provider API key as `AI_API_KEY` in "
                "`Dashboard/.env` to enable real-time conversational analysis."
            ),
            "grounding": grounding,
        }

    system_prompt = build_system_prompt(grounding)
    messages = [{"role": "system", "content": system_prompt}]

    # Append valid conversation history (last 8 messages max)
    if history and isinstance(history, list):
        for turn in history[-8:]:
            role = turn.get("role")
            content = turn.get("content")
            if role in ("user", "assistant") and isinstance(content, str) and content.strip():
                messages.append({"role": role, "content": content.strip()})

    messages.append({"role": "user", "content": message.strip()})

    api_format = config["api_format"]
    url = (
        f"{config['base_url']}/responses"
        if api_format == "responses"
        else f"{config['base_url']}/chat/completions"
    )
    headers = {
        "Authorization": f"Bearer {config['api_key']}",
        "Content-Type": "application/json",
    }
    if config["provider"].startswith("opencode"):
        headers["x-opencode-session"] = config["session_id"]
        headers["User-Agent"] = os.getenv("AI_USER_AGENT", "esp-mesh-dashboard/1.0").strip()
    if api_format == "responses":
        payload = {
            "model": config["model"],
            "input": messages,
            "max_output_tokens": 350,
        }
    else:
        payload = {
            "model": config["model"],
            "messages": messages,
            "max_tokens": 350,
            "temperature": 0.3,
        }

    own_client = False
    if client is None:
        client = httpx.AsyncClient(timeout=35.0)
        own_client = True

    try:
        response = await client.post(url, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        if api_format == "responses":
            reply_text = "\n".join(
                content["text"]
                for item in data.get("output", [])
                if item.get("type") == "message"
                for content in item.get("content", [])
                if content.get("type") == "output_text" and content.get("text")
            )
            if not reply_text:
                raise ValueError("AI provider returned no assistant text in the Responses API result")
        else:
            message = data["choices"][0]["message"]
            reply_text = (message.get("content") or "").strip()
            if not reply_text:
                reply_text = (message.get("reasoning_content") or "").strip()
            if not reply_text:
                raise ValueError("AI provider returned an empty assistant message")
        return {
            "configured": True,
            "reply": reply_text,
            "model": config["model"],
            "grounding": grounding,
        }
    except httpx.HTTPStatusError as exc:
        logger.error("AI upstream HTTP error: %s - %s", exc.response.status_code, exc.response.text)
        hint = ""
        if exc.response.status_code in (401, 402, 403):
            hint = " — check AI_API_KEY, account balance/credits, and provider access policy"
        return {
            "configured": True,
            "error": True,
            "model": config["model"],
            "reply": f"AI provider error ({exc.response.status_code}){hint}: {exc.response.text}",
            "grounding": grounding,
        }
    except Exception as exc:
        logger.error("AI upstream request failed: %s", exc)
        return {
            "configured": True,
            "error": True,
            "model": config["model"],
            "reply": f"Unable to reach AI provider: {str(exc)}",
            "grounding": grounding,
        }
    finally:
        if own_client:
            await client.aclose()
