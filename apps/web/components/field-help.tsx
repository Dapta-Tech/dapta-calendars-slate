/** R18 inline field help: a small “?” affordance with the explanation as its
 *  accessible name + native tooltip. Purely presentational (no client JS). */
export function FieldHelp({ text }: { text: string }) {
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      className="inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-border text-[10px] leading-none text-muted-foreground"
    >
      ?
    </span>
  );
}
