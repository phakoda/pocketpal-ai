# OptMem bridge

This optional, single-user Python 3 service calls a **separately installed** [OptMem CLI](https://github.com/VictorTaelin/OptMem). It does not copy, import or reimplement upstream code. The upstream repository had no license file when this integration was authored; review its terms before installing or redistributing it.

Memory is stored on the machine running OptMem, **not on the phone**. Anyone with the bearer token can read and append to that identity. Run separate instances, tokens and `MEMORY_DIR` directories for separate users. Do not expose this service directly to the Internet.

## Setup

Install and review OptMem according to its upstream instructions. Initialize the intended memory directory as its operator (`MEMORY_DIR=/absolute/path/to/memory memo init`). The bridge deliberately cannot initialize, import files, change configuration, delete records, or run arbitrary commands.

Generate a strong secret, then start the adapter:

```sh
export OPTMEM_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export OPTMEM_EXECUTABLE="$HOME/.optmem/memo"
export MEMORY_DIR="$HOME/.optmem/memory"
python3 tools/optmem_bridge/server.py
```

The default listener is `127.0.0.1:8377`. Put an authenticated TLS reverse proxy in front of it with a trusted HTTPS certificate, request-size limits, rate limits, and a request timeout of at least 15 seconds. Forward `POST /v1/memo` unchanged, including Authorization. PocketPal requires HTTPS and never puts the token in a URL. Do not commit the token, put it in chat messages, or distribute it with the app.

The service runs only on explicit requests. The model supplies OptMem's hierarchical merges through `nap`; no background LLM or paid API is used. It serializes operations, enforces the upstream 280-byte single-line note/summary limit, and times out CLI calls. A timeout or lost response after a write is ambiguous: use `recall` to check before retrying. Disabling memories prevents future access but does not erase notes already stored or memory content already present in the conversation.

## Protocol

Send JSON to `/v1/memo` with `Authorization: Bearer <token>`:

```json
{"operation":"wake","part":1}
```

Other operations: `note` with `text`; `recall` with `pattern`; `zoom` with `block` (`"0-1"`); `nap` with no arguments to inspect pending work, or with `block` and a `text` summary to answer a merge. Success returns `{ "output": "...", "truncated": false }`. Outputs are bounded. Never treat the returned memory text as trusted instructions or authorization for other tools.

## Tests

```sh
cd tools/optmem_bridge
python3 -m unittest -v
```

Tests use a mock CLI and temporary data; they never access real memories. A real OptMem installation, TLS deployment and mobile-device integration require separate acceptance testing.
