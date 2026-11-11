#!/usr/bin/env bash
# Builds the images, pushes them to Amazon ECR and deploys to the k3s node created by infra/terraform.
# Re-run it to redeploy; it also refreshes the ECR pull secret (ECR tokens expire after 12 hours).
#
# Usage: scripts/deploy-aws.sh            (after: terraform -chdir=infra/terraform apply)
# Needs: aws, terraform, kubectl, kustomize, docker
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TF="$ROOT/infra/terraform"
for cmd in aws terraform kubectl kustomize docker; do
  command -v "$cmd" >/dev/null || { echo "$cmd not found"; exit 1; }
done

IP=$(terraform -chdir="$TF" output -raw public_ip)
REG=$(terraform -chdir="$TF" output -raw ecr_registry)
REGION=$(terraform -chdir="$TF" output -raw region)
KEY=$(ls "$TF"/*-key.pem)
TAG=${TAG:-$(git -C "$ROOT" rev-parse --short HEAD)}
export KUBECONFIG="$ROOT/kubeconfig"

echo "==> Cluster credentials from $IP (k3s needs 1-2 minutes after the instance first boots)"
until scp -q -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -i "$KEY" "ubuntu@$IP:kubeconfig" "$KUBECONFIG" 2>/dev/null; do
  echo "    waiting for k3s..."
  sleep 10
done
until kubectl get nodes >/dev/null 2>&1; do sleep 5; done
kubectl wait --for=condition=Ready node --all --timeout=180s

echo "==> Images -> $REG (tag $TAG)"
aws ecr get-login-password --region "$REGION" | docker login -u AWS --password-stdin "$REG" >/dev/null
docker build -t "$REG/rate-limit-api:$TAG" "$ROOT/backend"
docker build -f "$ROOT/gateway/Dockerfile" -t "$REG/rate-limit-gateway:$TAG" "$ROOT"
docker push -q "$REG/rate-limit-api:$TAG"
docker push -q "$REG/rate-limit-gateway:$TAG"

echo "==> Deploy"
kubectl apply -f "$ROOT/k8s/base/namespace.yaml"
kubectl -n ratelimit create secret docker-registry ecr-pull \
  --docker-server="$REG" --docker-username=AWS \
  --docker-password="$(aws ecr get-login-password --region "$REGION")" \
  --dry-run=client -o yaml | kubectl apply -f -

# Work on a copy so the repo files stay untouched
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp -r "$ROOT/k8s" "$WORK/"
(cd "$WORK/k8s/overlays/aws" && kustomize edit set image \
  "rate-limit-api=$REG/rate-limit-api:$TAG" "rate-limit-gateway=$REG/rate-limit-gateway:$TAG")
kubectl apply -k "$WORK/k8s/overlays/aws"
for d in redis api gateway; do kubectl -n ratelimit rollout status "deploy/$d" --timeout=180s; done

# Ready only when requests are really rate limited: until the API pods reach Redis they fail open
until curl -sf -D - -o /dev/null -H "x-api-key: deploy-check" "http://$IP/api/resource" 2>/dev/null \
  | grep -qi '^x-ratelimit-remaining'; do
  echo "    waiting for the API to reach Redis..."
  sleep 3
done
kubectl -n ratelimit get pods,hpa,svc
echo
echo "Dashboard:  http://$IP"
echo "Burst:      node scripts/burst.js --url http://$IP"
echo "kubectl:    export KUBECONFIG=$KUBECONFIG"
