#!/usr/bin/env bash
# Serveur d'IA locale (vLLM, backend CPU) pour bks.
#   ./scripts/vllm.sh start    crée / démarre le conteneur (premier lancement : téléchargement du modèle)
#   ./scripts/vllm.sh stop     l'arrête (libère ~9 Go de RAM)
#   ./scripts/vllm.sh logs     suit les journaux
#   ./scripts/vllm.sh status   état + modèle servi
set -euo pipefail

NAME=bks-vllm
IMAGE=vllm/vllm-openai-cpu:v0.32.0-x86_64
MODEL=${BKS_VLLM_MODEL:-Qwen/Qwen3-4B-AWQ}
# Cache clé/valeur (Gio) : 1 Gio ≈ 7 000 jetons, assez pour 2 lots en parallèle.
KV_GIB=${BKS_VLLM_KV_GIB:-1}

wait_ready() {
  echo -n "Chargement du modèle (2 à 4 min)"
  for _ in $(seq 1 120); do
    if curl -fs -m 3 http://127.0.0.1:8000/v1/models >/dev/null; then echo " prêt."; return 0; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
      echo; echo "Le conteneur s'est arrêté :"; docker logs --tail 20 "$NAME"; return 1
    fi
    echo -n "."; sleep 5
  done
  echo; echo "Toujours pas prêt : ./scripts/vllm.sh logs"; return 1
}

case "${1:-status}" in
  start)
    if docker inspect "$NAME" >/dev/null 2>&1; then
      docker start "$NAME" >/dev/null
    else
      # Port publié sur 127.0.0.1 uniquement. SYS_NICE + seccomp : requis par vLLM CPU pour
      # épingler ses threads (doc vLLM, préférable à --privileged).
      docker run -d --name "$NAME" \
        --cap-add SYS_NICE --security-opt seccomp=unconfined --shm-size=2g \
        -p 127.0.0.1:8000:8000 \
        -v bks-hf-cache:/root/.cache/huggingface \
        -e VLLM_CPU_KVCACHE_SPACE="$KV_GIB" \
        "$IMAGE" \
        "$MODEL" --max-model-len 6144 --host 0.0.0.0 --port 8000 \
        --structured-outputs-config '{"backend": "xgrammar", "disable_any_whitespace": true}' >/dev/null
    fi
    wait_ready
    ;;
  stop) docker stop "$NAME" >/dev/null && echo "Arrêté." ;;
  logs) docker logs -f --tail 50 "$NAME" ;;
  status)
    if curl -fs -m 3 http://127.0.0.1:8000/v1/models | grep -o '"id":"[^"]*"' | head -1; then
      docker stats --no-stream --format 'mémoire : {{.MemUsage}}' "$NAME"
    else
      echo "vLLM arrêté (./scripts/vllm.sh start)"
    fi
    ;;
  *) echo "usage : $0 {start|stop|logs|status}"; exit 2 ;;
esac
