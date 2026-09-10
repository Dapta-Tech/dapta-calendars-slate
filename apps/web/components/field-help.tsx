/** R18 inline field help: a small focusable “?” affordance. The explanation is
 *  the accessible name (announced on keyboard focus, not hover-title-only) and
 *  the native tooltip for mouse users. Type=button so it never submits or, when
 *  nested in a &lt;label&gt;, toggles the label's control.
 *
 *  A2 (#112): the MARK stays 16px — it is a hint beside a field label and a
 *  bigger disc would compete with the label it explains — but the button around
 *  it is now a 44px square with a transparent, zero-layout-cost bleed. The
 *  negative margin keeps it visually where it was, so no caller's spacing
 *  changes, while the thumb gets a real target (mobile bar, R28). */
export function FieldHelp({ text }: { text: string }) {
  return (
    <button
      type="button"
      aria-label={text}
      title={text}
      onClick={(e) => e.preventDefault()}
      className="-m-3 inline-flex h-11 w-11 shrink-0 cursor-help items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-2xs leading-none text-muted-foreground"
      >
        ?
      </span>
    </button>
  );
}
