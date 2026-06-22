import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/* Document shell for the worktree surfaces.
 *
 *   <Document>
 *     <Document.Head title="shop-checkout-v2" status={<Pill />} tools={…}/>
 *     <Document.Body>
 *       <CommandPill … />
 *       <TodoBanner … />
 *       <Section title="Services">…</Section>
 *     </Document.Body>
 *     <Document.Footer>
 *       <Composer />
 *       <ContextLine />
 *     </Document.Footer>
 *   </Document>
 */

type DocumentProps = HTMLAttributes<HTMLElement>;

function Document({ className, children, ...props }: DocumentProps) {
  return (
    <section
      data-slot="document"
      className={cn(
        "flex flex-col min-h-0 h-full bg-[color:var(--surface)] text-[color:var(--ink)]",
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}

type DocumentHeadProps = HTMLAttributes<HTMLDivElement> & {
  title?: ReactNode;
  status?: ReactNode;
  tools?: ReactNode;
};

function DocumentHead({
  className,
  title,
  status,
  tools,
  children,
  ...props
}: DocumentHeadProps) {
  return (
    <div
      data-slot="document-head"
      className={cn(
        "flex items-center gap-3.5 px-9 py-4 border-b border-[color:var(--hair)]",
        className,
      )}
      {...props}
    >
      {title !== undefined ? (
        <div className="text-[15px] font-medium text-[color:var(--ink)] inline-flex items-center gap-1.5 min-w-0">
          {title}
        </div>
      ) : null}
      {status !== undefined && status !== null ? (
        <span className="text-[12px] text-[color:var(--muted-foreground)] inline-flex items-center gap-1.5">
          {status}
        </span>
      ) : null}
      <div className="flex-1 min-w-0">{children}</div>
      {tools !== undefined && tools !== null ? (
        <div className="inline-flex items-center gap-0.5 text-[color:var(--muted-foreground)]">
          {tools}
        </div>
      ) : null}
    </div>
  );
}

type DocumentBodyProps = HTMLAttributes<HTMLDivElement> & {
  maxWidth?: string;       /* override the default 880px reading column */
  /**
   * Whether the body manages its own scrollbar. Default `true` keeps the
   * existing v3 behaviour for worktree pages (Body is the single scroll
   * surface inside a bounded Document). Pass `false` for pages that want the
   * outer `main` scrollbar to handle overflow — avoids the double-scrollbar
   * stacking you get when both surfaces are active at once.
   */
  scrollable?: boolean;
};

function DocumentBody({
  className,
  maxWidth = "880px",
  scrollable = true,
  children,
  ...props
}: DocumentBodyProps) {
  return (
    <div
      data-slot="document-body"
      className={cn(
        scrollable
          ? "flex-1 overflow-auto"
          : "flex-1",
        "px-14 pt-9 pb-6 [&_h1]:text-[22px] [&_h1]:font-semibold",
        "[&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:mt-6 [&_h2]:mb-2.5",
        "[&_p]:text-[14.5px] [&_p]:leading-[1.65] [&_p]:text-[color:var(--ink-2)] [&_p]:my-2.5",
        "[&_ul]:my-2 [&_ol]:my-2 [&_ul]:pl-5 [&_ol]:pl-5",
        "[&_li]:text-[14.5px] [&_li]:leading-[1.7] [&_li]:text-[color:var(--ink-2)]",
        "[&_strong]:text-[color:var(--ink)] [&_strong]:font-semibold",
        className,
      )}
      {...props}
    >
      <div className="mx-auto w-full" style={{ maxWidth }}>
        {children}
      </div>
    </div>
  );
}

type DocumentFooterProps = HTMLAttributes<HTMLDivElement>;

function DocumentFooter({ className, children, ...props }: DocumentFooterProps) {
  return (
    <div
      data-slot="document-footer"
      className={cn(
        "border-t border-[color:var(--hair)] bg-[color:var(--surface)] px-9 pt-3.5 pb-4",
        "flex flex-col gap-3",
        className,
      )}
      {...props}
    >
      <div className="mx-auto w-full max-w-[880px] flex flex-col gap-3">{children}</div>
    </div>
  );
}

type DocumentSectionProps = HTMLAttributes<HTMLElement> & {
  title?: ReactNode;
  meta?: ReactNode;       /* "4 units, all running" */
  actions?: ReactNode;
};

function DocumentSection({
  className,
  title,
  meta,
  actions,
  children,
  ...props
}: DocumentSectionProps) {
  return (
    <section
      data-slot="document-section"
      className={cn("mt-6 first:mt-0", className)}
      {...props}
    >
      {(title !== undefined || meta !== undefined || actions !== undefined) ? (
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 mb-2.5">
          {title !== undefined ? (
            <h2 className="text-[16px] font-semibold text-[color:var(--ink)] m-0">{title}</h2>
          ) : null}
          {meta !== undefined && meta !== null ? (
            <span className="text-[13px] text-[color:var(--muted-foreground)]">{meta}</span>
          ) : null}
          {actions !== undefined && actions !== null ? (
            <span className="ml-auto inline-flex items-center gap-2">{actions}</span>
          ) : null}
        </header>
      ) : null}
      <div>{children}</div>
    </section>
  );
}

Document.Head = DocumentHead;
Document.Body = DocumentBody;
Document.Footer = DocumentFooter;
Document.Section = DocumentSection;

export { Document, DocumentHead, DocumentBody, DocumentFooter, DocumentSection };
export type {
  DocumentProps,
  DocumentHeadProps,
  DocumentBodyProps,
  DocumentFooterProps,
  DocumentSectionProps,
};
