import { render } from 'preact';

/** Props for the badge: a label and an optional emphasis flag. */
interface BadgeProps {
  label: string;
  strong?: boolean;
}

/** A pill-shaped badge used all over the place in this imaginary app. */
function Badge(props: BadgeProps) {
  return <span className={props.strong ? 'badge strong' : 'badge'}>{props.label}</span>;
}

/** The align choices the toolbar supports, spelled out as a type alias. */
type Align = 'left' | 'center' | 'right';

/** Keeps track of how often each toolbar button has been pressed. */
class PressCounter {
  counts = new Map<string, number>();
  press(id: string): void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
  }
}

/** The toolbar — the component this file is really about. */
export function Toolbar({ align }: { align: Align }) {
  return (
    <div className={`toolbar ${align}`}>
      <Badge label="saved" />
    </div>
  );
}

/** A footer nobody looks at, present to give the toolbar a sibling below. */
function Footer() {
  return <footer className="footer">fin — © nobody</footer>;
}
