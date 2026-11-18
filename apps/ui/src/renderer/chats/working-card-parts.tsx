import { type AvatarLook, MemberAvatar } from '../components/member-avatar';
import { cn } from '../components/ui/utils';

/**
 * A control of a working-agents or working-threads panel under the pointer:
 * the menu's row tint, since `muted` is one shade off this popover surface in
 * the dark theme.
 */
export const CONTROL_HOVER =
  'transition-colors duration-150 ease-out hover:bg-accent motion-reduce:transition-none';

export type TileActivity = 'working' | 'waiting' | 'idle';

/** The one agent a folded card draws its face from. */
export interface AgentsTileFace {
  name: string;
  colorKey: string;
  avatar?: AvatarLook;
}

/** The folded card at rest: one readable face, how many more, and whether anyone works. */
export function AgentsTile({
  face,
  others,
  activity,
}: {
  face: AgentsTileFace;
  others: number;
  activity: TileActivity;
}): React.JSX.Element {
  return (
    <span
      data-slot="working-agents-tile"
      data-activity={activity}
      className={cn(
        'relative grid size-8',
        others > 0 ? 'place-items-start p-px' : 'place-items-center',
      )}>
      <span className="relative flex size-7 items-center justify-center">
        {activity === 'idle' ? null : (
          <span
            aria-hidden="true"
            data-slot="working-agents-tile-ring"
            className={cn(
              'absolute inset-0 rounded-full border-2',
              activity === 'working'
                ? 'animate-spin border-primary/25 border-t-primary motion-reduce:animate-none'
                : 'border-muted-foreground/40',
            )}
          />
        )}
        <MemberAvatar
          size={24}
          name={face.name}
          colorKey={face.colorKey}
          avatar={face.avatar}
        />
      </span>
      {others > 0 ? (
        <span
          data-slot="working-agents-tile-more"
          className="absolute right-px bottom-px rounded-full bg-popover px-0.5 text-[9px] leading-[10px] font-medium text-foreground tabular-nums">
          +{others}
        </span>
      ) : null}
    </span>
  );
}
