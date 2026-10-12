"""
Async LLM client for self-hosted or hosted models.

  * ollama — Ollama-style `POST {base}/api/generate` ({model, prompt, system, stream: false})
  * openai — any OpenAI-compatible `POST {base}/v1/chat/completions` (OpenAI, vLLM, LM Studio,
             llama.cpp server, Groq, Together, ...)
"""
import json
import re

import httpx

from . import config

THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def extract_text(data) -> str:
    """Pull the generated text out of the common response shapes."""
    if isinstance(data, str):
        return data
    if isinstance(data, dict):
        for key in ("response", "text", "output", "generated_text", "content", "result"):
            if isinstance(data.get(key), str):
                return data[key]
        if data.get("choices"):
            choice = data["choices"][0]
            if isinstance(choice.get("text"), str):
                return choice["text"]
            if isinstance(choice.get("message"), dict):
                return choice["message"].get("content") or ""
        if isinstance(data.get("message"), dict):
            return data["message"].get("content", "")
    if isinstance(data, list) and data:
        return extract_text(data[0])
    return json.dumps(data)


class LLMClient:
    def __init__(self, provider: str, base_url: str, path: str, model: str, timeout: float,
                 api_key: str = "", temperature: float = 0.1, transport: httpx.AsyncBaseTransport | None = None):
        self.provider = provider
        self.url = base_url + path
        self.model = model
        self.temperature = temperature
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=15), headers=headers,
                                        transport=transport)

    def _payload(self, prompt: str, system: str | None, max_tokens: int) -> dict:
        if self.provider == "openai":
            messages = ([{"role": "system", "content": system}] if system else []) + [
                {"role": "user", "content": prompt}]
            return {"model": self.model, "messages": messages, "temperature": self.temperature,
                    "max_tokens": max_tokens, "stream": False}
        payload = {"model": self.model, "prompt": prompt, "stream": False,
                   "options": {"temperature": self.temperature, "num_predict": max_tokens}}
        if system:
            payload["system"] = system
        return payload

    async def generate(self, prompt: str, system: str | None = None, max_tokens: int = 4096) -> str:
        resp = await self.client.post(self.url, json=self._payload(prompt, system, max_tokens))
        resp.raise_for_status()
        try:
            data = resp.json()
        except ValueError:
            # Some servers stream NDJSON even when asked not to — stitch the pieces.
            parts = []
            for line in resp.text.splitlines():
                if line.strip():
                    try:
                        parts.append(extract_text(json.loads(line)))
                    except ValueError:
                        parts.append(line)
            return "".join(parts)
        return THINK_RE.sub("", extract_text(data)).strip()


def default_client() -> LLMClient:
    return LLMClient(config.LLM_PROVIDER, config.LLM_BASE_URL, config.LLM_GENERATE_PATH, config.LLM_MODEL,
                     config.LLM_TIMEOUT, config.LLM_API_KEY, config.LLM_TEMPERATURE)
