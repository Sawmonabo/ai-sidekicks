# Claude Code Logging & Debugging Guide

## Complete Reference for Monitoring Agents, Tools, Models, and Prompts

**Last Updated:** February 3, 2026

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [CLI Flags](#cli-flags)
   - [Verbose Mode](#verbose-mode)
   - [Debug Mode](#debug-mode)
4. [OpenTelemetry Logging](#opentelemetry-logging)
   - [Environment Variables](#environment-variables)
   - [What Gets Logged](#what-gets-logged)
   - [Console Output](#console-output)
   - [OTLP Export](#otlp-export)
5. [Troubleshooting](#troubleshooting)
6. [References](#references)

---

## Overview

Claude Code provides multiple logging mechanisms to inspect what agents, tools, models, and prompts are being used during execution. This is invaluable for:

- **Debugging**: Understanding why Claude made certain decisions
- **Cost Monitoring**: Tracking token usage and estimated costs
- **Performance Analysis**: Measuring tool and request durations
- **Audit Trails**: Recording what actions were taken

---

## Quick Start

### Instant Verbose Output

```bash
claude --verbose
```

### Full Structured Logging

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=console
export OTEL_LOG_TOOL_DETAILS=1
claude
```

---

## CLI Flags

### Verbose Mode

Shows turn-by-turn details of Claude's actions:

```bash
claude --verbose
```

**Output includes:**
- Tool invocations and results
- Model responses
- Agent transitions

### Debug Mode

More granular tracing with optional category filtering:

```bash
# Enable all debug output
claude --debug

# Filter specific categories
claude --debug "api,mcp"

# Exclude specific categories
claude --debug "!statsig,!file"
```

**Available debug categories:**

| Category | Description |
|----------|-------------|
| `api` | API request/response details |
| `mcp` | MCP server communication |
| `hooks` | Hook execution |
| `file` | File operations |
| `statsig` | Feature flag checks |

---

## OpenTelemetry Logging

OpenTelemetry provides structured, production-grade logging with detailed metrics.

### Environment Variables

#### Core Variables

| Variable | Description | Values |
|----------|-------------|--------|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | Master switch for telemetry | `1` to enable |
| `OTEL_METRICS_EXPORTER` | Where to send metrics | `console`, `otlp`, `none` |
| `OTEL_LOGS_EXPORTER` | Where to send logs | `console`, `otlp`, `none` |

#### Detail Control

| Variable | Description | Values |
|----------|-------------|--------|
| `OTEL_LOG_USER_PROMPTS` | Include full prompt text | `1` to enable |
| `OTEL_LOG_TOOL_DETAILS` | Include tool/agent/skill names | `1` to enable |

#### Timing Control

| Variable | Description | Default |
|----------|-------------|---------|
| `OTEL_METRIC_EXPORT_INTERVAL` | Metrics export interval (ms) | `60000` |
| `OTEL_LOGS_EXPORT_INTERVAL` | Logs export interval (ms) | `30000` |

#### OTLP Export Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint | `http://localhost:4317` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Protocol to use | `grpc`, `http/protobuf` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth headers | `Authorization=Bearer token` |

### What Gets Logged

#### Per-Request Information

```json
{
  "model": "claude-opus-4-5-20251101",
  "input_tokens": 1523,
  "output_tokens": 847,
  "cost_usd": 0.0234,
  "duration_ms": 3421
}
```

#### Per-Tool Information

```json
{
  "tool_name": "Read",
  "success": true,
  "duration_ms": 12,
  "mcp_server_name": "filesystem",
  "skill_name": "git"
}
```

#### Per-Prompt Information (when `OTEL_LOG_USER_PROMPTS=1`)

```json
{
  "prompt_length": 156,
  "prompt": "Fix the authentication bug in login.ts"
}
```

### Console Output

For local development and debugging:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=console
export OTEL_LOGS_EXPORTER=console
export OTEL_METRIC_EXPORT_INTERVAL=1000
export OTEL_LOGS_EXPORT_INTERVAL=1000
export OTEL_LOG_USER_PROMPTS=1
export OTEL_LOG_TOOL_DETAILS=1
claude
```

### OTLP Export

For production monitoring with observability backends (Prometheus, Datadog, Grafana, etc.):

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
export OTEL_LOG_USER_PROMPTS=1
export OTEL_LOG_TOOL_DETAILS=1
claude
```

---

## Troubleshooting

### DEBUG Environment Variable Conflict

Claude Code v2.0.32+ auto-enables debug mode if `DEBUG=True` exists in a project's `.env` file. To avoid conflicts:

```bash
# Use Claude-specific variable instead
export CLAUDE_DEBUG=1
```

### Logs Not Appearing

1. Verify telemetry is enabled:
   ```bash
   echo $CLAUDE_CODE_ENABLE_TELEMETRY  # Should be "1"
   ```

2. Check exporter configuration:
   ```bash
   echo $OTEL_LOGS_EXPORTER  # Should be "console" or "otlp"
   ```

3. Reduce export interval for faster output:
   ```bash
   export OTEL_LOGS_EXPORT_INTERVAL=1000
   ```

### OTLP Connection Issues

1. Verify endpoint is reachable:
   ```bash
   curl -v $OTEL_EXPORTER_OTLP_ENDPOINT
   ```

2. Check protocol matches your collector:
   ```bash
   # For gRPC collectors
   export OTEL_EXPORTER_OTLP_PROTOCOL=grpc

   # For HTTP collectors
   export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
   ```

---

## References

- [Claude Code CLI Reference](https://docs.anthropic.com/en/docs/claude-code/cli-reference)
- [Claude Code Monitoring Documentation](https://docs.anthropic.com/en/docs/claude-code/monitoring)
- [OpenTelemetry Environment Variables](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/)

---

## Summary Table

| Use Case | Method | Command/Config |
|----------|--------|----------------|
| Quick debugging | CLI flag | `claude --verbose` |
| Filtered tracing | CLI flag | `claude --debug "api,mcp"` |
| Full telemetry | Env vars | See [Console Output](#console-output) |
| Production monitoring | OTLP | See [OTLP Export](#otlp-export) |
