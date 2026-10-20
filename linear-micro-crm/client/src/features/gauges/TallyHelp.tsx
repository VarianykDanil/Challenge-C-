// The tally's help line, shared by the Tally card (TallyMode.tsx) and Quick gauges (pages/QuickGauges.tsx): a tap
// counts one person at the furthest stage they reached (tallyPerson), so the earlier stages go up with it.

/** The two sentences, each kept whole: where the line needs two rows it breaks between them. */
const TALLY_HELP_LINES = ['Tap the furthest stage each person reached.', 'Earlier stages count too.'] as const;

export function TallyHelp() {
  return (
    <>
      {TALLY_HELP_LINES.map((line, i) => (
        <span key={i}>
          {i > 0 && ' '}
          <span className="inline-block">{line}</span>
        </span>
      ))}
    </>
  );
}
