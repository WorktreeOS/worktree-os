import { test, expect, describe } from "bun:test";
import {
  formatAddress,
  formatHealthchecks,
  formatStatus,
  formatStatusTable,
} from "@worktreeos/ui/format";
import type { AppPortHealthcheckResult } from "@worktreeos/runtime/healthchecks";

describe("formatAddress", () => {
  test("renders published tcp port as a clickable URL", () => {
    expect(
      formatAddress({ containerPort: 3000, hostPort: 32769, protocol: "tcp" }),
    ).toBe("http://localhost:32769 -> 3000/tcp");
  });

  test("marks unpublished ports", () => {
    expect(formatAddress({ containerPort: 5432, protocol: "tcp" })).toBe(
      "5432/tcp (unpublished)",
    );
  });

  test("wraps published tcp address in OSC-8 hyperlink when enabled", () => {
    const out = formatAddress(
      { containerPort: 3000, hostPort: 32769, protocol: "tcp" },
      { hyperlinks: true },
    );
    expect(out).toBe(
      "\x1b]8;;http://localhost:32769\x1b\\http://localhost:32769 -> 3000/tcp\x1b]8;;\x1b\\",
    );
  });

  test("respects explicit host ip in display and url", () => {
    const out = formatAddress(
      {
        containerPort: 80,
        hostPort: 8080,
        hostIp: "192.168.1.10",
        protocol: "tcp",
      },
      { hyperlinks: true },
    );
    expect(out).toBe(
      "\x1b]8;;http://192.168.1.10:8080\x1b\\http://192.168.1.10:8080 -> 80/tcp\x1b]8;;\x1b\\",
    );
  });

  test("renders non-tcp protocols as host:port without http://", () => {
    const out = formatAddress(
      { containerPort: 53, hostPort: 53, protocol: "udp" },
      { hyperlinks: true },
    );
    expect(out).toBe("localhost:53 -> 53/udp");
  });

  test("skips hyperlink for unpublished ports", () => {
    const out = formatAddress(
      { containerPort: 5432, protocol: "tcp" },
      { hyperlinks: true },
    );
    expect(out).toBe("5432/tcp (unpublished)");
  });
});

describe("formatStatus", () => {
  test("renders a row per service", () => {
    const out = formatStatus([
      {
        service: "app",
        state: "running",
        ports: [
          { containerPort: 3000, hostPort: 32769, protocol: "tcp" },
        ],
      },
      { service: "db", state: "running", ports: [] },
    ]);
    expect(out).toContain("app");
    expect(out).toContain("running");
    expect(out).toContain("http://localhost:32769 -> 3000/tcp");
    expect(out).toContain("db");
    expect(out).toContain("(no published ports)");
  });

  test("emits OSC-8 hyperlinks when option is enabled", () => {
    const out = formatStatus(
      [
        {
          service: "app",
          state: "running",
          ports: [
            { containerPort: 3000, hostPort: 32769, protocol: "tcp" },
          ],
        },
      ],
      { hyperlinks: true },
    );
    expect(out).toContain("\x1b]8;;http://localhost:32769\x1b\\");
    expect(out).toContain("http://localhost:32769 -> 3000/tcp");
    expect(out).toContain("\x1b]8;;\x1b\\");
  });

  test("returns placeholder when no services exist", () => {
    expect(formatStatus([])).toBe("(no services)");
  });
});

describe("formatHealthchecks", () => {
  function r(over: Partial<AppPortHealthcheckResult>): AppPortHealthcheckResult {
    return {
      service: "api",
      containerPort: 3000,
      state: "healthy",
      enabled: true,
      allowFailure: false,
      ...over,
    };
  }

  test("returns empty string when nothing to render", () => {
    expect(formatHealthchecks([])).toBe("");
  });

  test("renders healthy, failed, failed-allowed, disabled states", () => {
    const text = formatHealthchecks([
      r({ state: "healthy", url: "http://localhost:21001/", observedStatus: 200 }),
      r({
        service: "api",
        containerPort: 3001,
        state: "failed",
        message: "expected HTTP 200, got 500",
        url: "http://localhost:21002/",
      }),
      r({
        service: "api",
        containerPort: 3002,
        state: "failed-allowed",
        allowFailure: true,
        message: "expected HTTP 200, got 500",
      }),
      r({
        service: "api",
        containerPort: 3003,
        state: "disabled",
        enabled: false,
      }),
    ]);
    expect(text).toContain("api:3000");
    expect(text).toContain("healthy");
    expect(text).toContain("FAILED");
    expect(text).toContain("failed (allowed)");
    expect(text).toContain("disabled");
    expect(text).toContain("expected HTTP 200, got 500");
  });
});

describe("formatStatusTable", () => {
  function hc(over: Partial<AppPortHealthcheckResult>): AppPortHealthcheckResult {
    return {
      service: "api",
      containerPort: 4010,
      state: "healthy",
      enabled: true,
      allowFailure: false,
      observedStatus: 200,
      url: "http://localhost:29325/",
      expectedStatus: 200,
      ...over,
    };
  }

  test("returns placeholder when no services", () => {
    expect(formatStatusTable([], [])).toBe("(no services)");
  });

  test("renders header + one row per published port with merged health", () => {
    const out = formatStatusTable(
      [
        {
          service: "api",
          state: "running",
          ports: [{ containerPort: 4010, hostPort: 29325, protocol: "tcp" }],
        },
        {
          service: "app",
          state: "running",
          ports: [{ containerPort: 4200, hostPort: 27446, protocol: "tcp" }],
        },
      ],
      [
        hc({ service: "api", containerPort: 4010 }),
        hc({ service: "app", containerPort: 4200, url: "http://localhost:27446/" }),
      ],
    );
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^SERVICE\s+STATUS\s+ADDRESS\s+HEALTH$/);
    expect(lines[1]).toContain("api");
    expect(lines[1]).toContain("running");
    expect(lines[1]).toContain("http://localhost:29325 -> 4010/tcp");
    expect(lines[1]).toContain("healthy 200");
    expect(lines[2]).toContain("app");
    expect(lines[2]).toContain("healthy 200");
    expect(out).not.toContain("healthcheck "); // no separate healthcheck section
  });

  test("renders em-dash for services without configured healthcheck", () => {
    const out = formatStatusTable(
      [
        {
          service: "db",
          state: "running",
          ports: [{ containerPort: 5432, hostPort: 32001, protocol: "tcp" }],
        },
      ],
      [],
    );
    expect(out).toContain("db");
    expect(out).toContain("5432/tcp");
    expect(out).toContain("—");
  });

  test("shows compact FAILED reason from message", () => {
    const out = formatStatusTable(
      [
        {
          service: "api",
          state: "running",
          ports: [{ containerPort: 4010, hostPort: 29325, protocol: "tcp" }],
        },
      ],
      [
        hc({
          state: "failed",
          message: "expected HTTP 200, got 500",
          observedStatus: 500,
        }),
      ],
    );
    expect(out).toContain("FAILED — got 500");
  });

  test("shows timeout shorthand", () => {
    const out = formatStatusTable(
      [
        {
          service: "api",
          state: "running",
          ports: [{ containerPort: 4010, hostPort: 29325, protocol: "tcp" }],
        },
      ],
      [
        hc({
          state: "failed",
          message: "healthcheck attempt timed out after 2000ms",
        }),
      ],
    );
    expect(out).toContain("FAILED — timeout");
  });

  test("shows disabled and waiting states", () => {
    const out = formatStatusTable(
      [
        {
          service: "api",
          state: "running",
          ports: [
            { containerPort: 4010, hostPort: 29325, protocol: "tcp" },
            { containerPort: 4011, hostPort: 29326, protocol: "tcp" },
          ],
        },
      ],
      [
        hc({ containerPort: 4010, state: "disabled", enabled: false }),
        hc({ containerPort: 4011, state: "waiting" }),
      ],
    );
    expect(out).toContain("disabled");
    expect(out).toContain("waiting");
  });

  test("pads columns by visible width ignoring OSC-8 escapes", () => {
    const out = formatStatusTable(
      [
        {
          service: "api",
          state: "running",
          ports: [{ containerPort: 4010, hostPort: 29325, protocol: "tcp" }],
        },
        {
          service: "app-partner",
          state: "running",
          ports: [{ containerPort: 4210, hostPort: 20529, protocol: "tcp" }],
        },
      ],
      [
        hc({ service: "api", containerPort: 4010 }),
        hc({ service: "app-partner", containerPort: 4210 }),
      ],
      [],
      { hyperlinks: true },
    );
    const lines = out.split("\n").slice(1); // skip header
    // Strip OSC-8 escapes and ensure the HEALTH column starts at the same
    // visible offset on both rows.
    const stripped = lines.map((l) =>
      l.replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""),
    );
    const offsets = stripped.map((l) => l.indexOf("healthy"));
    expect(offsets[0]).toBe(offsets[1]);
  });

  test("renders no-published-ports row for service without ports", () => {
    const out = formatStatusTable(
      [{ service: "db", state: "running", ports: [] }],
      [],
    );
    expect(out).toContain("(no published ports)");
  });

  test("renders TUNNEL column with active public URL", () => {
    const out = formatStatusTable(
      [
        {
          service: "api",
          state: "running",
          ports: [{ containerPort: 4010, hostPort: 29325, protocol: "tcp" }],
        },
      ],
      [hc({ service: "api", containerPort: 4010 })],
      [
        {
          service: "api",
          containerPort: 4010,
          hostPort: 29325,
          state: "active",
          url: "http://feature-login-api.example.com",
          hostname: "feature-login-api.example.com",
        },
      ],
    );
    expect(out).toContain("TUNNEL");
    expect(out).toContain("http://feature-login-api.example.com");
  });

  test("renders TUNNEL column with FAILED message for failed tunnel", () => {
    const out = formatStatusTable(
      [
        {
          service: "api",
          state: "running",
          ports: [{ containerPort: 4010, hostPort: 29325, protocol: "tcp" }],
        },
      ],
      [hc({ service: "api", containerPort: 4010 })],
      [
        {
          service: "api",
          containerPort: 4010,
          hostPort: 29325,
          state: "failed",
          message: "tunnel server bind failed",
        },
      ],
    );
    expect(out).toContain("FAILED — tunnel server bind failed");
  });

  test("omits TUNNEL column when tunnels list is empty", () => {
    const out = formatStatusTable(
      [
        {
          service: "api",
          state: "running",
          ports: [{ containerPort: 4010, hostPort: 29325, protocol: "tcp" }],
        },
      ],
      [hc({ service: "api", containerPort: 4010 })],
      [],
    );
    expect(out).not.toContain("TUNNEL");
  });

  test("renders em-dash for ports without matching tunnel snapshot", () => {
    const out = formatStatusTable(
      [
        {
          service: "api",
          state: "running",
          ports: [
            { containerPort: 4010, hostPort: 29325, protocol: "tcp" },
            { containerPort: 4011, hostPort: 29326, protocol: "tcp" },
          ],
        },
      ],
      [
        hc({ service: "api", containerPort: 4010 }),
        hc({ service: "api", containerPort: 4011 }),
      ],
      [
        {
          service: "api",
          containerPort: 4010,
          hostPort: 29325,
          state: "active",
          url: "https://preview-api.loca.lt",
          hostname: "preview-api.loca.lt",
        },
      ],
    );
    const lines = out.split("\n");
    expect(lines[1]).toContain("https://preview-api.loca.lt");
    expect(lines[2]).toContain("—");
  });
});
