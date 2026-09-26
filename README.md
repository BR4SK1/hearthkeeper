# hearthkeeper

A collaborative storytelling app where an LLM acts as game master. Players send actions through a web client; the GM streams narration and can return synthesized speech through a compatible text-to-speech service.

## Requirements

- Node.js 20 or newer
- pnpm 10
- MongoDB for the campaign memory service
- An OpenRouter API key for GM narration
- A Chatterbox-compatible TTS service for generated speech (optional for text-only operation)

## Local development

```sh
corepack enable
pnpm install
cp .env.example .env
# Set OPENROUTER_API_KEY and configure the external TTS service in .env.
pnpm build
pnpm test
pnpm dev
```

The web client runs on port 3000, the GM service on port 3001, and the memory service on port 3002 by default. See `.env.example` for configurable settings. Missing filler audio files are handled gracefully; the app uses text-only acknowledgments.

## Containers and Kubernetes

Dockerfiles are in `deploy/docker`. Generic Kubernetes resources and an example Kustomize overlay are in `deploy/k8s`. Before applying them, set your image names and ingress host in `deploy/k8s/overlays/example`, provide the external TTS endpoint, and create a Kubernetes Secret named `openrouter-key` with an `OPENROUTER_API_KEY` key.
