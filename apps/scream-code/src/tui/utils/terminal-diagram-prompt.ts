/**
 * Telling the model that this terminal draws diagrams — and how to do it well.
 *
 * Rendering a Mermaid block as a picture is a presentation-layer fact the model
 * cannot observe: nothing in its request says the transcript will be drawn.
 *
 * This note deliberately governs three things a model cannot guess, and leaves
 * the rest alone:
 *
 * - **whether the feature exists at all**, and that not using it is the failure
 *   mode rather than the cautious one;
 * - **how a good diagram reads** — one idea per frame, structure in the picture
 *   and judgement in the prose;
 * - **which style fits a terminal** — horizontal first, vertical when the frame
 *   outgrows six blocks, split rather than trim.
 *
 * The note is deliberately static. An earlier draft tried to tell the model the
 * reader's live terminal width; the mechanism worked in tests but the model on
 * the other end cannot observe the terminal, so the claim had to be injected at
 * runtime, could lag a request, and was a contradiction waiting to happen.
 * Layout guidance therefore uses a number the model can apply without knowing
 * the reader's window: a horizontal frame past about six blocks no longer fits.
 *
 * *When* to draw is not governed. It is judgement, and models are getting better
 * at it than any list here can be. Two drafts over-corrected in opposite
 * directions: a note with only format rules read as "ways to fail", so a careful
 * model drew nothing; a note with an enumerated set of occasions read as a
 * permission list, so it drew only inside them and started trimming what it
 * explained. So the occasions below are labelled illustrations of a single test,
 * and the test itself says: would the reader get this faster from a picture.
 *
 * This is the TUI's own prompt segment. Other surfaces (web, machine-readable
 * output) do not draw diagrams and must not receive it, which is why it is
 * appended at runtime from here rather than living in the shared prompt file.
 */

import { isMermaidDrawing } from './ui-preferences';

/**
 * Appended to the system prompt while diagrams are being drawn. Static by
 * design — see the file header.
 */
export function diagramCapabilityPrompt(): string {
  return `# Terminal diagram rendering

Assistant replies in this terminal draw Mermaid blocks as pictures: a
\`\`\`mermaid fence is rendered as box art in place of its source. The user
switched this on deliberately and wants it used. A reply that would have been
clearer as a diagram, and was written as prose anyway, is the miss to avoid —
not the safe choice.

What gets drawn is the answer shown to the user. Text handed to another agent —
a subagent's report back to the one that spawned it, or a tool result — is not
rendered anywhere, so draw for the reader at the far end of the chain.

## When to draw — this part is your judgement
One test: **would the reader understand this faster from a picture than from the
sentences?** If following the explanation makes anyone hold several things in
their head at once — paths that fork, parts that talk to each other, states that
change, quantities that trade off — draw it. If a reader would have to re-read,
or scroll back and forth, to follow it, it was a diagram.

Nothing below narrows that test. The occasions listed further down illustrate it;
they are not a set of permitted cases, and something unlisted is just as worth
drawing if it passes.

Do not wait to be asked, do not ask permission, and do not offer to draw
something instead of drawing it.

## How to draw well
- One diagram, one idea. If describing it needs an "and also", split it.
- The picture carries structure; the prose carries judgement — what you
  concluded, what is risky, what to do next. Do not have both do the same work.
- Do not narrate a diagram line by line, and do not cut the reasoning because you
  drew it.
- Place it where the reader meets it first — usually just after the sentence that
  says what the reply is about.
- Draw when it earns its place. A one-line answer, a greeting, or a bare fact
  with no relations in it does not need one.

## Style
**Lay diagrams out horizontally (\`LR\`) by default.**

A frame cannot be scaled or wrapped to fit — that misaligns every box — so the
layout has to pick a shape that fits. **One rule covers both directions: never
put more than five blocks side by side.**

Width comes from what sits next to each other, and that is about 12 columns per
block, so five side by side lands around 60 columns — comfortable on any normal
window. Measured:

- In \`LR\` (left-right) the whole chain sits side by side: about 35 columns for
  three blocks, 48 for four, **61 for five**, 74 for six. A long chain is a wide
  chain, however few branches it has — which is why five is the limit and six is
  already over it, even though six looks barely different.
- In \`TD\` (top-down) only the **widest layer** sits side by side: a straight chain
  is 10 columns however long it runs, but a layer fanned into five parallels is
  already 58, and eight is 94.

\`LR\` stays the default because vertical space is the scarce dimension here — a
frame the reader must scroll to finish is worse than one that fits at a glance —
and the same graph comes out three to four times shorter than in \`TD\`. Branching
alone is not a reason to switch; a decision with two exits reads fine
left-to-right.

This is a shape rule, not a size limit on the answer: a \`TD\` chain may carry ten
nodes happily, and splitting stays available for any size. How much you explain,
how deep you go, and how many diagrams a reply deserves are yours to decide; a
long walkthrough may well carry five.

### When a frame would not fit
Work down this ladder and stop at the first rung that fits:

1. Shorten the labels.
2. Switch direction or flatten the fan — a chain too wide in \`LR\` becomes
   \`TD\`; a \`TD\` layer fanning past five wants those branches chained or split.
3. Split it into two or three frames: an overview, then the detail better
   labelled by the split itself.
4. Still not enough? **Draw it too wide.** The frame falls back to showing its
   own source, which a reader can widen the window for or paste into a renderer
   elsewhere.

What is never on the ladder: cutting content, dropping the parts that make it
interesting, or skipping the diagram because it might not fit. Undrawn source is
still information; content you never wrote is gone.

Do not ask whether a diagram should be redrawn to fit, and do not report
compliance with these rules. Work the ladder and move on.

## Shapes that render
\`flowchart\`/\`graph\` (including \`subgraph\`), \`sequenceDiagram\`,
\`stateDiagram\`, \`classDiagram\` and \`erDiagram\`. Anything else — \`mindmap\`,
\`gantt\`, \`pie\`, \`journey\` and the rest — stays on screen as the code you wrote,
so pick one of the shapes above.

## Occasions that pass the test
Illustrations, not a checklist:

- Control flow with branches, retries, fallbacks, early exits.
- Three or more parties exchanging messages — async ordering, cancellation,
  callbacks.
- Lifecycles and mode changes: session states, run phases, approval flows,
  backoff loops.
- Module and layer relationships: who depends on whom, what is wired to what,
  which component owns which step.
- Data and entity relationships, with cardinality.
- A race or an interleaving — why two things that were each fine happened in the
  wrong order.
- The shape of a mechanism: how a value is transformed on its way through, where
  a number comes from, what a cache actually holds.
- A before/after or two-option comparison where the shape of the difference is
  the point.
- A walkthrough — where a value comes from, how a call reaches a handler, why one
  path diverges from another.

## Keep the source
Leave the fenced block as valid Mermaid and put no prose inside it. The fence is
both the picture's source and its fallback — what a reader sees when they turn
rendering off, or open this session somewhere that cannot draw.`;
}

/**
 * Whether this surface is currently claiming the capability. \`off\` means the
 * blocks would be shown as source, so promising rendering there would be a lie
 * and would push the model toward diagrams it renders as code.
 */
export function describesDiagramRendering(): boolean {
  return isMermaidDrawing();
}

/** Minimal shape needed to sync the segment; keeps this free of SDK types. */
interface DiagramPromptTarget {
  setRuntimeSystemPrompt(prompt: { append?: string }): Promise<void>;
}

/**
 * Publish or withdraw the capability statement on a session.
 *
 * Best effort by design: a prompt that failed to sync costs the model one piece
 * of context, whereas letting the failure escape would cost the user a session
 * they were trying to open.
 */
export async function syncDiagramCapabilityPrompt(
  session: DiagramPromptTarget | null | undefined,
): Promise<void> {
  if (!session) return;
  const append = describesDiagramRendering() ? diagramCapabilityPrompt() : '';
  try {
    await session.setRuntimeSystemPrompt({ append });
  } catch {
    // Ignored deliberately — see above.
  }
}