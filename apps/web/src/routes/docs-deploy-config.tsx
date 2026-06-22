import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Document } from "@/routes/worktree/document";
import { HighlightedCode } from "@/components/ui/highlighted-code";
import { Ic } from "@/components/ui/inline-code";

/* In-app documentation for authoring project deploy configs. Reachable
 * directly at `/docs/deploy-config` and linked from first-run completion and
 * worktree missing/invalid config states. Kept intentionally compact; the
 * README in the repo is the source of truth for deeper reference. */
export function DeployConfigDocsRoute() {
  return (
    <Document data-testid="docs-deploy-config">
      <Document.Head
        title={
          <span className="inline-flex items-center gap-2">
            <Link
              to="/"
              aria-label="Back to dashboard"
              className="inline-flex items-center justify-center size-[22px] rounded-md text-[color:var(--muted-foreground)] hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)] transition-colors"
            >
              <ArrowLeft className="size-[14px]" />
            </Link>
            <span>deploy config docs</span>
          </span>
        }
        status={<span>reference</span>}
      />
      <Document.Body>
        <p>
          Every WorktreeOS worktree resolves its deployment configuration from a
          project-local <Ic>.wos/</Ic> directory in the source worktree. The{" "}
          source/root worktree reads <Ic>.wos/deploy.yaml</Ic>; every secondary
          worktree reads <Ic>.wos/deploy.worktree.yaml</Ic>. Both files live in
          the source worktree — secondary checkouts do not need their own copy.
        </p>
        <p>
          The project-local <Ic>.wos/</Ic> directory is repository configuration
          and is distinct from <Ic>$WOS_HOME</Ic> (<Ic>~/.wos</Ic>), which holds
          runtime storage — the daemon socket, session state, and managed
          worktree data. Keep deployment config under <Ic>.wos/</Ic> in your
          repo; never put it in <Ic>$WOS_HOME</Ic>.
        </p>

        <Document.Section title="Generated mode">
          <p>
            Generated mode lets WorktreeOS assemble Docker Compose from a small
            number of declarative fields. This is the default mode; you only
            have to declare an app image and one or more <Ic>app.services</Ic>{" "}
            entries.
          </p>
          <YamlBlock testId="docs-generated-example">{`app:
  image: oven/bun:1
  init_script: |
    bun install
  services:
    web:
      script: bun run dev
      ports:
        - 3000

deps:
  postgres:
    enabled: true
`}</YamlBlock>
          <ul>
            <li>
              <Ic>app.image</Ic> — base image used for every app container.
            </li>
            <li>
              <Ic>app.init_script</Ic> — runs once before services start. Use
              it for install / migrate / seed steps.
            </li>
            <li>
              <Ic>app.services</Ic> — long-running app processes. Each entry
              declares <Ic>script</Ic> and one or more <Ic>ports</Ic>.
            </li>
            <li>
              <Ic>app.services.&lt;name&gt;.ports</Ic> — list of container
              ports. WorktreeOS allocates host ports and rewires healthchecks
              automatically.
            </li>
            <li>
              Each port has a default healthcheck that polls{" "}
              <Ic>GET /</Ic> until it returns <Ic>200</Ic>. Override per port
              with <Ic>healthcheck</Ic> blocks.
            </li>
            <li>
              <Ic>deps</Ic> — managed datastores such as <Ic>postgres</Ic> and{" "}
              <Ic>redis</Ic>. WorktreeOS provisions them with sane defaults and
              forwards connection details to your app via env vars.
            </li>
          </ul>
        </Document.Section>

        <Document.Section title="Dynamic ports">
          <p>
            <Ic>dynamic_ports</Ic> is a top-level flag that defaults to{" "}
            <Ic>true</Ic>. With dynamic ports, WorktreeOS allocates a free host
            port for each declared managed port from <Ic>host_ports.range</Ic>{" "}
            and retries on conflicts.
          </p>
          <p>
            Set <Ic>dynamic_ports: false</Ic> to publish or bind every declared
            managed port to the <em>same</em> host port (container port{" "}
            <Ic>3000</Ic> → host port <Ic>3000</Ic>). Static ports ignore{" "}
            <Ic>host_ports.range</Ic> and fail with an actionable error on a
            duplicate or unavailable port instead of reallocating. Use it for
            the source/root worktree when you want predictable fixed ports — for
            example a shell-mode root deployment — and keep{" "}
            <Ic>dynamic_ports: true</Ic> for secondary worktrees so several
            worktrees can run at once.
          </p>
          <YamlBlock testId="docs-dynamic-ports-example">{`dynamic_ports: false
app:
  image: oven/bun:1
  services:
    web:
      script: bun run dev
      ports:
        - 3000
`}</YamlBlock>
        </Document.Section>

        <Document.Section title="Service init_script">
          <p>
            A service can declare its own <Ic>init_script</Ic>, which WorktreeOS
            runs once before the long-running command starts. Use it to
            generate code, wait for migrations, or seed per-service data.
          </p>
          <YamlBlock>{`app:
  services:
    api:
      init_script: |
        bun run db:migrate
      script: bun run start
      ports:
        - 4000
`}</YamlBlock>
        </Document.Section>

        <Document.Section title="Cache and clone volumes">
          <p>
            <Ic>cache</Ic> entries persist package-manager state across
            worktrees so installs stay fast. Common targets: <Ic>node_modules</Ic>,
            <Ic>~/.bun</Ic>, <Ic>~/.cache/pnpm</Ic>, <Ic>~/.cache/pip</Ic>.
          </p>
          <YamlBlock>{`cache:
  node_modules:
    key: package-lock.json
  bun_install:
    key: bun.lockb
    path: ~/.bun/install/cache
`}</YamlBlock>
          <p>
            <Ic>clone_volumes</Ic> mirrors paths from the source worktree into
            the running container without copying the entire repo. Use them
            for build artefacts you want to keep host-side.
          </p>
          <YamlBlock>{`clone_volumes:
  - .next
  - source: dist
    destination: /workspace/dist
`}</YamlBlock>
          <p>
            <strong>Windows.</strong> Drive-letter host paths are supported and
            are not split at the drive colon — in <Ic>clone_volumes</Ic> a bare{" "}
            <Ic>C:\shared\.env</Ic> is one path, and in generated-mode{" "}
            <Ic>app.services.*.volumes</Ic> a host path like{" "}
            <Ic>C:\cache:/cache</Ic> is parsed as <em>host</em>:
            <em>container</em>, not split at the drive colon. When a mapping
            would be ambiguous, prefer the object form{" "}
            <Ic>{`{ source, destination }`}</Ic> shown above.
          </p>
        </Document.Section>

        <Document.Section title="Targets and arguments">
          <p>
            <Ic>targets</Ic> bundle multiple services under a single name so a
            launch command can select <Ic>--target backend</Ic> instead of
            listing every service.
          </p>
          <YamlBlock>{`targets:
  backend:
    - api
    - worker
  frontend:
    - web
`}</YamlBlock>
          <p>
            <Ic>arguments</Ic> declares runtime argument names the launcher
            can pass. Each declared name is exposed as an env variable inside
            services, gated to the names you list.
          </p>
          <YamlBlock>{`arguments:
  - APP_REVIEW_TOKEN
  - FEATURE_FLAG
`}</YamlBlock>
        </Document.Section>

        <Document.Section title="Compose mode">
          <p>
            Set <Ic>mode: compose</Ic> when you already own a Docker Compose
            file and want WorktreeOS to manage lifecycle, port allocation, and
            tunnels around it. Generated-mode fields (<Ic>app</Ic>,{" "}
            <Ic>deps</Ic>, <Ic>targets</Ic>, <Ic>arguments</Ic>) are not
            allowed in this mode.
          </p>
          <YamlBlock testId="docs-compose-example">{`mode: compose
compose:
  config: ./docker-compose.yml
  expose:
    - service: web
      port: 3000
    - service: api
      port: 4000
`}</YamlBlock>
          <ul>
            <li>
              <Ic>compose.config</Ic> — relative path to the compose file.
            </li>
            <li>
              <Ic>compose.expose</Ic> — services and container ports WorktreeOS
              should publish, register healthchecks for, and expose through
              tunnels.
            </li>
          </ul>
        </Document.Section>

        <Document.Section title="Shell mode">
          <p>
            Set <Ic>mode: shell</Ic> when your project runs its services with
            host-native commands and does not need Docker. WorktreeOS keeps the
            same worktree lifecycle — first-run setup, clone volumes, caches,
            service selection, targets, runtime arguments, host-port allocation,
            healthchecks, tunnels, status, logs, and service actions — but starts
            each service as a host process instead of a Docker container.
          </p>
          <p>
            <strong>Windows.</strong> Shell commands run through a Windows host
            shell (<Ic>cmd.exe</Ic>) instead of POSIX <Ic>sh -lc</Ic>. Commands
            still run in order with per-command directory isolation, but write
            Windows-compatible commands (e.g. <Ic>set FOO=bar</Ic>, not{" "}
            <Ic>export FOO=bar</Ic>). Service trees are stopped with{" "}
            <Ic>taskkill</Ic>.
          </p>
          <YamlBlock testId="docs-shell-example">{`mode: shell
app:
  init_script:
    - bun install
  services:
    api:
      script:
        - bun run dev
      cwd: packages/api
      ports:
        - 3000
      env_file: .env
      environment:
        DATABASE_URL: postgres://localhost:5432/app
    web:
      script:
        - bun run web
      dependencies:
        - api
`}</YamlBlock>
          <p>
            Supported service fields: <Ic>script</Ic> (required), <Ic>cwd</Ic>,{" "}
            <Ic>ports</Ic>, <Ic>env_file</Ic>, <Ic>environment</Ic>,{" "}
            <Ic>init_script</Ic>, and <Ic>dependencies</Ic>. Top-level{" "}
            <Ic>app.init_script</Ic>, <Ic>clone_volumes</Ic>, <Ic>cache</Ic>,{" "}
            <Ic>targets</Ic>, <Ic>arguments</Ic>, <Ic>host_ports</Ic>, and{" "}
            <Ic>dynamic_ports</Ic> work the same as generated-compose mode. Init
            scripts run as host shell commands from the worktree root (or the
            service <Ic>cwd</Ic>).
          </p>
          <p>
            Docker-only fields are rejected: <Ic>app.image</Ic>,{" "}
            <Ic>app.services.*.image</Ic>, <Ic>deps</Ic>,{" "}
            <Ic>app.services.*.volumes</Ic>, and package-manager cache mounts
            (<Ic>connect_npm_cache</Ic>, <Ic>connect_yarn_cache</Ic>,{" "}
            <Ic>connect_bun_cache</Ic>).
          </p>
          <p>
            <strong>Port binding contract.</strong> A configured port is a
            logical service port for which WorktreeOS allocates a host port from{" "}
            <Ic>host_ports</Ic> (or the same port number when{" "}
            <Ic>dynamic_ports: false</Ic>). In shell mode the service process
            must listen on the allocated host port itself.
          </p>
          <p>
            <strong>Service environment contract.</strong>{" "}
            <Ic>WOS_SERVICE_PORT</Ic> and <Ic>WOS_SERVICE_HOSTNAME</Ic> are a
            shared convenience pair injected by both shell mode and Docker-backed
            generated mode, describing a service's <em>first</em> configured
            port:
          </p>
          <ul>
            <li>
              <Ic>WOS_SERVICE_PORT</Ic> — the allocated host port for the first
              configured service port.
            </li>
            <li>
              <Ic>WOS_SERVICE_HOSTNAME</Ic> — the resolved hostname for that
              port: the service tunnel hostname when tunnels are active,{" "}
              <Ic>localhost</Ic> otherwise.
            </li>
          </ul>
          <p>
            In generated Docker mode the same pair is injected into each app
            service container with a configured port, so service code reads it
            without branching by runtime mode. Services without any configured
            port receive neither variable. These automatic values always win
            over user-supplied values, and the <Ic>WOS_*</Ic> namespace is
            reserved. For services with multiple ports, use the exact templates{" "}
            <Ic>{"${app.services.<name>.hostPort[<port>]}"}</Ic> and{" "}
            <Ic>{"${app.services.<name>.hostname[<port>]}"}</Ic> in{" "}
            <Ic>environment</Ic> to reference secondary ports.
          </p>
        </Document.Section>

        <div className="mt-8">
          <Button asChild variant="default" size="sm">
            <Link to="/">
              <ArrowLeft className="size-[14px]" />
              Back to dashboard
            </Link>
          </Button>
        </div>
      </Document.Body>
    </Document>
  );
}

function YamlBlock({
  children,
  testId,
}: {
  children: string;
  testId?: string;
}) {
  return <HighlightedCode code={children} language="YAML" data-testid={testId} />;
}
