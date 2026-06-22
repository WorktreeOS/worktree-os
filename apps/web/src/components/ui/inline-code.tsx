import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/* InlineCode (Ic) — monospace chip used for paths, ports, branch names,
 * shell commands. By default rendered as <code>; pass `href` to render as
 * an anchor instead.
 *
 *     <Ic>localhost:5432</Ic>
 *     <Ic href="https://acme-shop.tunnel.dev">acme-shop.tunnel.dev</Ic>
 *     <Ic tone="dim">→</Ic>
 */

type IcTone = "default" | "dim" | "danger";

type IcCommon = {
  tone?: IcTone;
  className?: string;
  children: ReactNode;
};

type IcCodeProps = IcCommon & HTMLAttributes<HTMLElement> & { href?: never };

type IcAnchorProps = IcCommon & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

type IcProps = IcCodeProps | IcAnchorProps;

function toneClass(tone: IcTone = "default"): string {
  if (tone === "dim") {
    return "bg-transparent text-[color:var(--ink-2)] px-0";
  }
  if (tone === "danger") {
    return "bg-[color:var(--bad-soft)] text-[color:var(--bad)]";
  }
  return "bg-[color:var(--chip-bg)] text-[color:var(--ink)]";
}

const base =
  "font-mono whitespace-nowrap rounded-[5px] px-[6px] py-[1px] text-[0.92em] leading-[1.4] align-baseline";

function Ic(props: IcProps) {
  const tone = toneClass(props.tone);

  if ("href" in props && props.href !== undefined) {
    const { tone: _tone, className, children, ...anchorProps } = props;
    return (
      <a
        data-slot="inline-code-link"
        className={cn(base, tone, "no-underline hover:underline underline-offset-2", className)}
        {...anchorProps}
      >
        {children}
      </a>
    );
  }

  const { tone: _tone, className, children, ...codeProps } = props as IcCodeProps;
  return (
    <code
      data-slot="inline-code"
      className={cn(base, tone, className)}
      {...codeProps}
    >
      {children}
    </code>
  );
}

export { Ic };
export type { IcProps, IcTone };
