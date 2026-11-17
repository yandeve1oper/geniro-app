import type { Meta, StoryObj } from '@storybook/react-vite';

import { ShowAllButton, useShowAll } from './show-all';

const DEVICES = [
  'iPhone',
  'iPad',
  'Work laptop',
  'Pixel',
  'Kitchen tablet',
  'Old phone',
  'Guest phone',
];

function List({ limit }: { limit: number }): React.JSX.Element {
  const { shown, expanded, setExpanded } = useShowAll(DEVICES, limit);
  return (
    <div className="flex flex-col gap-2">
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
        {shown.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <ShowAllButton
        total={DEVICES.length}
        limit={limit}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        noun="devices"
      />
    </div>
  );
}

const meta = {
  title: 'Components/ShowAllButton',
  component: ShowAllButton,
  args: {
    total: DEVICES.length,
    limit: 5,
    expanded: false,
    onToggle: () => undefined,
    noun: 'devices',
  },
} satisfies Meta<typeof ShowAllButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The newest few, then a press for the rest. */
export const NewestFew: Story = {
  render: () => <List limit={5} />,
};

/** A list hidden whole until asked for. */
export const HiddenUntilShown: Story = {
  render: () => <List limit={0} />,
};
