/**
 * Placeholder for a route group the shell reserves but a later phase builds (dev-spec §5). Keeps
 * the nav complete so M5/M7/M8/M9 slot their screens in without reworking the shell.
 */

export function Stub({
  title,
  phase,
  children,
}: {
  title: string;
  phase: string;
  children: string;
}) {
  return (
    <div className="stub panel">
      <h1 className="u">{title}</h1>
      <p>
        {children}
        <br />
        <br />
        <span className="tag">{phase}</span>
      </p>
    </div>
  );
}
