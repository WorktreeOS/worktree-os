import { Toaster as SonnerToaster, type ToasterProps } from "sonner";

export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "group rounded-[10px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] text-[color:var(--ink)] shadow-[0_18px_50px_-22px_rgb(0_0_0/0.35)]",
          title: "text-[13.5px] font-semibold tracking-[-0.005em]",
          description: "text-[12.5px] text-[color:var(--ink-2)]",
          actionButton:
            "rounded-md bg-[color:var(--ink)] px-2.5 py-1 text-[12px] text-[color:var(--surface)]",
          cancelButton:
            "rounded-md bg-[color:var(--chip-bg)] px-2.5 py-1 text-[12px] text-[color:var(--ink-2)]",
          success: "text-[color:var(--ink)]",
          error:
            "border-[color:color-mix(in_oklch,var(--bad)_45%,var(--hair-2))] text-[color:var(--bad)]",
        },
      }}
      {...props}
    />
  );
}

export { toast } from "sonner";
