# ResQFlow AI Qwen3 Local v9 - Robust Tamil Voice

Uses local Qwen3 8B via Ollama plus a deterministic multilingual symptom extractor. Tamil/English typed and voice transcripts are normalized together. The safety layer explicitly extracts Tamil symptom stems and merges them with the LLM output so symptoms are not silently dropped.

Run Ollama: `ollama run qwen3:8b`
Run server: `cd server && npm install && npm run dev`
Run web: `cd web && npm install && npm run dev`
