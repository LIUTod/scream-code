import { Text } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { ActivityPaneComponent } from '#/tui/components/panes/activity-pane';

describe('ActivityPaneComponent', () => {
  it('renders waiting loader after a spacer', () => {
    const component = new ActivityPaneComponent({
      mode: 'waiting',
      spinner: new Text('loading', 0, 0) as never,
    });

    expect(component.render(80).map((line) => line.trimEnd())).toEqual(['', 'loading']);
  });

  it('renders composing spinner after a spacer', () => {
    const component = new ActivityPaneComponent({
      mode: 'composing',
      spinner: new Text('working', 0, 0) as never,
    });

    expect(component.render(80).map((line) => line.trimEnd())).toEqual(['', 'working']);
  });

  it('renders nothing for hidden and thinking modes', () => {
    expect(new ActivityPaneComponent({ mode: 'hidden' }).render(80)).toEqual([]);
    expect(new ActivityPaneComponent({ mode: 'thinking' }).render(80)).toEqual([]);
  });
});
