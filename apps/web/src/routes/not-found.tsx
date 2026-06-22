import { Link } from "react-router";

import { Button } from "@/components/ui/button";

export function NotFoundRoute() {
  return (
    <section className="reveal flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="relative">
        <div className="select-none font-mono text-[10rem] leading-none font-bold tracking-tighter text-foreground/[0.06]">
          404
        </div>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[10.5px] uppercase tracking-[0.3em] text-[color:var(--signal-warn)]">
          route not found
        </div>
      </div>
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold tracking-tight">Not found</h2>
        <p className="text-sm text-muted-foreground">
          The requested page does not exist.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link to="/">← Back to start</Link>
      </Button>
    </section>
  );
}
