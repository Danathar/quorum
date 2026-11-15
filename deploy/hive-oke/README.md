# Shared Vexa service on hive-oke

Quorum (RFC #1) uses one shared Vexa control plane per cluster. On hive-oke it runs in namespace
`meetings`, and nothing outside that namespace is touched. The only cluster-scoped object is the
`meetings` Namespace.

| File                 | What it is                                                                             |
| -------------------- | -------------------------------------------------------------------------------------- |
| `namespace.yaml`     | Namespace `meetings` (Pod Security baseline in warn/audit mode)                        |
| `values.yaml`        | Helm values for the Vexa chart, plus the `quorum` block read by `install.sh`           |
| `versitygw.yaml`     | In-namespace S3 endpoint (versitygw, POSIX backend on a 50Gi `oci-bv` PVC), bucket Job |
| `transcription.yaml` | CPU Whisper (faster-whisper `small`, int8) Deployment and Service                      |
| `policy.yaml`        | LimitRange and gateway NetworkPolicy                                                   |
| `install.sh`         | Idempotent install/upgrade: Secrets, policy, ResourceQuota, storage, STT, Helm, tenant |
| `smoke.sh`           | Smoke test with the tenant key from a throwaway Pod                                    |
| `smoke_api.py`       | The API half of the smoke test (health, `/ws`, chat, speak), run inside that Pod       |

## Versions (all pinned by tag and digest)

Everything Vexa comes from one commit of hivecommons/vexa `main`: de9cb887c15d13d1a2010b96e7ebad6493191f98 (chart 0.13.4).
It is upstream Vexa `main` plus our patches (hivecommons/vexa#2 Teams chat-write, #3 speak route).
Upstream v0.12.28 has no meeting chat-post route and its `/ws` sends no chat events; both
are on upstream `main`, and upstream publishes control-plane images only for releases.

| Component                                     | Image                                                       |
| --------------------------------------------- | ----------------------------------------------------------- |
| Chart                                         | `deploy/helm/charts/vexa` at hivecommons/vexa de9cb88 (chart 0.13.4) |
| gateway | `ghcr.io/hivecommons/vexa-gateway:main-de9cb88-quorum` |
| admin-api | `ghcr.io/hivecommons/vexa-admin-api:main-de9cb88-quorum` |
| meeting-api | `ghcr.io/hivecommons/vexa-meeting-api:main-de9cb88-quorum` |
| runtime | `ghcr.io/hivecommons/vexa-runtime:main-de9cb88-quorum` |
| meeting bot | `ghcr.io/hivecommons/vexa-bot:main-de9cb88-quorum` |
| CPU transcription | `ghcr.io/hivecommons/vexa-transcription-cpu:main-de9cb88-quorum` |
| agent-api, agent-worker (pinned, unused) | `ghcr.io/hivecommons/vexa-agent-api`, `vexa-agent-worker` `:main-de9cb88-quorum` |
| mcp (pinned, disabled) | `ghcr.io/hivecommons/vexa-mcp:main-de9cb88-quorum` |
| postgres                                      | `docker.io/library/postgres:17.11-alpine`                   |
| redis                                         | `docker.io/valkey/valkey:8.1.11-alpine`                     |
| S3                                            | `docker.io/versity/versitygw:v1.10.0`                       |

Digests are in `values.yaml` and `transcription.yaml`. Each Vexa image is a manifest list with
linux/amd64 and linux/arm64, built on native runners by `.github/workflows/quorum-images.yml` in
hivecommons/vexa (`source=main`). Every hive-oke node is arm64. Images must be fully qualified
(`docker.io/...`, `ghcr.io/...`) because hive-oke runs CRI-O with short-name mode set to
enforcing.

## What runs

- Control plane: gateway x2, admin-api x2, meeting-api x2, runtime x1 (k8s backend, namespaced
  Role only), postgres, redis. agent-api, mcp, terminal, and dashboard are disabled: Quorum needs
  none of them, so no model credentials live here.
- The chart's bot seccomp installer (`runtime.botSandbox`, a hostPath DaemonSet on every node) is
  off: it writes node files outside `meetings` and its Pods would take the bot slots in the pod
  quota. Bots run under RuntimeDefault seccomp, as they did on v0.12.
- All Services are ClusterIP. There is no Ingress, LoadBalancer, or NodePort (the ResourceQuota
  also caps `services.loadbalancers` and `services.nodeports` at 0).
- Bots: one bare Pod per meeting, created by the runtime. Each is Guaranteed at 1 CPU / 2560Mi
  (`runtime.workloadResources.meetingBot`) and pinned to `kubernetes.io/arch: arm64`.
- Transcription: `vexa-transcription:8000`, 2-4 CPU / 2-4Gi. It needs `TRANSCRIPTION_SERVICE_TOKEN`.

## Meeting API used by Quorum

- `POST /bots/{platform}/{native_meeting_id}/chat` posts into the meeting chat (Teams: the
  bot types into the meeting chat, hivecommons/vexa#2). It answers a 4xx while the bot is not yet
  in the meeting.
- `/ws` (header `X-API-Key`) sends `meeting.status` frames for the tenant's meetings, and chat
  and transcript frames for meetings it subscribes to (`{"action": "subscribe", "meetings":
  [{"platform": ..., "native_id": ...}]}`).
- `POST` / `DELETE /bots/{platform}/{native_meeting_id}/speak`: see Voice.

## Voice

Voice is **off**. A speaking bot synthesizes through an OpenAI-compatible TTS service
(`TTS_SERVICE_URL` + `/v1/audio/speech`, header `X-API-Key: $TTS_API_TOKEN`, 24 kHz s16le PCM),
which meeting-api hands to bots sent with `voice_agent_enabled: true`. Vexa `main` ships no TTS
service: the only one it ever had (`services/tts-service`, removed after v0.9) forwarded to the
paid OpenAI API. So `meetings` has no `TTS_SERVICE_URL`, `VOICE_AGENT_ENABLED` is `false`,
`POST /bots` with `voice_agent_enabled: true` answers 422, and `POST .../speak` answers 409 (the
route exists). Turning voice on needs a self-hosted CPU TTS that serves that endpoint, deployed
in `meetings` with `TTS_SERVICE_URL` / `TTS_API_TOKEN` set on meeting-api.

## Privacy defaults

- `RECORDING_ENABLED=false`: no audio or video recording unless a request explicitly asks for it.
- The captured-signal tape (raw capture uploads for replay) is off twice: the chart default
  (`diagnostics.captureSignal: "false"`, `VEXA_CAPTURE_SIGNAL_DEFAULT`), and fleet-wide through
  admin-api `PUT /internal/settings/diagnostics {"capture_signal": "false"}`, which `install.sh`
  applies on every run. `smoke.sh` checks the setting reads `"false"` and the bucket is empty.
- Bot display name: "Hive notes (AI notetaker)".

## Limits

- `quorum.maxConcurrentBots: 4` in `values.yaml` is the single source. It is enforced in two places:
  - ResourceQuota `meetings-quota` sets `pods` = `controlPlanePods` (11) + 4. A quota cannot select
    only bot Pods, so while a rollout surges or an ops Pod runs, that Pod uses a bot slot, and
    a rollout waits for a free slot.
  - The tenant user's `max_concurrent_bots` in admin-api, set to the same value.
- LimitRange `meetings-defaults` sets defaults for containers without resources: 1-1.5 CPU,
  1100Mi-2560Mi, per upstream bot guidance. The per-container max is 4 CPU / 6Gi.

## Network

NetworkPolicy `vexa-gateway-ingress` (`policy.yaml`) allows gateway ingress (TCP 8000) only from
namespaces with the label key `hive.kubestellar.io/hive-id`, and from `meetings`. The chart's own
NetworkPolicies (`networkPolicy.enabled`) are off: one has the same name, and its namespace-wide
default-deny would also block versitygw and the transcription service, which the chart does not
render.

**hive-oke runs flannel, which does not enforce NetworkPolicy.** The policy records intent and
starts working only if the CNI changes. The real boundary is the per-tenant Vexa API key: the
bot, meeting, and transcript routes require `X-API-Key` (scopes `bot` / `tx`), and each tenant
sees only its own meetings.

## Secrets (names only; values are random, created by install.sh, never in git)

| Secret                         | Keys                                                                                                                                                                                   | Used by                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `vexa-admin`                   | `ADMIN_API_TOKEN`, `INTERNAL_API_SECRET`, `TRANSCRIPTION_SERVICE_TOKEN`, `VEXA_DISPATCH_SIGNING_KEY`, `NEXTAUTH_SECRET`, `VEXA_SERVICE_AUTHORITY_SECRET`, `VEXA_SYSTEM_WEBHOOK_SECRET`, `REDIS_PASSWORD`, `RUNTIME_API_TOKEN`, `VEXA_MCP_DELEGATION_SECRET` | chart (`secrets.existingSecretName`), transcription                                      |
| `vexa-s3`                      | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                                                                                                                                           | chart (`storage.s3.existingSecret`), versitygw root user                                 |
| `vexa-tenant-hivecommons-hive` | `api-key`                                                                                                                                                                              | hive's hive (hosted hive `hosted-available-oke-11-placeholder-r05x`); scopes `bot`, `tx` |
| `postgres-credentials`         | chart-managed                                                                                                                                                                          | postgres                                                                                 |

The admin credential is `ADMIN_API_TOKEN` (header `X-Admin-API-Key` on admin-api). Following
the upstream Kubernetes docs, it is minted at install time and kept in `vexa-admin`.

## Install / upgrade

```bash
git clone https://github.com/hivecommons/vexa.git /tmp/hivecommons-vexa
git -C /tmp/hivecommons-vexa checkout de9cb887c15d13d1a2010b96e7ebad6493191f98   # quorum.vexaCommit in values.yaml
KUBE_CONTEXT=hive-oke VEXA_CHART=/tmp/hivecommons-vexa/deploy/helm/charts/vexa ./install.sh
KUBE_CONTEXT=hive-oke ./smoke.sh
```

`install.sh` adds any `vexa-admin` key a newer chart needs (random value, existing keys never
change), then runs `helm upgrade --install --wait`.

Chart 0.13 refuses the database password the 0.12 chart published (`postgres`): admin-api and
meeting-api do not boot with it. The chart's fix is a `post-upgrade` hook, but `--wait` waits
for those Pods first, so the first 0.12 to 0.13 upgrade never finishes alone. On hive-oke this was
done by hand while helm waited (2026-11-15): `ALTER ROLE postgres` with a new random password over
the postgres Pod's local socket, the same value into Secret `postgres-credentials`, then the
crashing Pods deleted. The hook then ran and rotated it once more. Later upgrades are not affected.

New tenant: run admin-api `POST /admin/users` (with `max_concurrent_bots`), then
`POST /admin/users/{id}/tokens` with `{"scopes": ["bot", "tx"]}`, from inside the admin-api Pod
(see `install.sh`). Store the key in `vexa-tenant-<tenant>`.

## Rebuilding from hivecommons/vexa main

1. Land the change on hivecommons/vexa `main` (a PR, merged with a merge commit). The daily
   `quorum-upstream-sync.yml` merges upstream `main` in as well.
2. A push to `main` builds that commit (`quorum-images.yml`, `source=main`). To build by hand:
   `gh workflow run quorum-images.yml --repo hivecommons/vexa --ref main -f source=main -f ref=main`
   (or `-f ref=<sha>`).
3. The run's summary and its `digests` artifact list each image as
   `ghcr.io/hivecommons/vexa-<name>:main-<short sha>-quorum@sha256:...` with both platforms.
4. Open a PR here that sets `quorum.vexaCommit`, every tag and digest in `values.yaml`, and the
   transcription image in `transcription.yaml`. Pin `main-<short sha>-quorum` plus the digest,
   never the moving `main-quorum`. Then check out that commit and run `install.sh` and `smoke.sh`.

`source=release` (upstream release tag + our patches, `<tag>-quorum.N`) still exists for the
bot images, and with `images=all` for the control plane. It works only while our patches apply
to the release tag.

## Rollback

To the previous Helm revision (Secrets, PVCs and the tenant key are kept):

```bash
helm --kube-context hive-oke -n meetings history vexa
helm --kube-context hive-oke -n meetings rollback vexa <revision> --wait
```

The database is not rolled back: services migrate its schema forward at startup. Before the
0.12 to 0.13 upgrade a `pg_dumpall` was saved on the postgres volume
(`/var/lib/postgresql/data/backup/`).

To remove everything:

```bash
helm --kube-context hive-oke uninstall vexa -n meetings
kubectl --context hive-oke delete namespace meetings   # also deletes PVCs, Secrets, tenant keys
```
