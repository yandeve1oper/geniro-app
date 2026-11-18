import {
  BookOpen,
  ChartColumn,
  FolderGit2,
  KanbanSquare,
  type LucideIcon,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  RadioTower,
  Settings,
  UsersRound as TeamIcon,
} from 'lucide-react';

import {
  RAIL_COLLAPSED_WIDTH,
  RAIL_EXPANDED_WIDTH,
} from '../../shared/contracts';
import { Logo } from './logo';
import { cn } from './ui/utils';

/** The top-level views the nav rail switches between. */
export type AppView =
  | 'chats'
  | 'command-center'
  | 'teams'
  | 'tasks'
  | 'projects'
  | 'knowledge'
  | 'stats'
  | 'settings';

export interface NavItem {
  view: AppView;
  label: string;
  icon: LucideIcon;
}

/** Primary destinations (pinned to the top). */
const PRIMARY_ITEMS: readonly NavItem[] = [
  { view: 'chats', label: 'Chats', icon: MessageSquare },
  { view: 'command-center', label: 'Command center', icon: RadioTower },
  { view: 'teams', label: 'Teams', icon: TeamIcon },
  { view: 'tasks', label: 'Tasks', icon: KanbanSquare },
  { view: 'projects', label: 'Projects', icon: FolderGit2 },
  { view: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { view: 'stats', label: 'Stats', icon: ChartColumn },
];

/** Utility destinations (pinned to the bottom). */
const SECONDARY_ITEMS: readonly NavItem[] = [
  { view: 'settings', label: 'Settings', icon: Settings },
];

/**
 * Every destination in rail order — what the phone's bottom tab bar draws, so
 * the two navigations cannot disagree about a view's name or icon.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  ...PRIMARY_ITEMS,
  ...SECONDARY_ITEMS,
];

function NavButton({
  item,
  active,
  collapsed,
  count,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  /** What waits on the user there; zero draws nothing. */
  count: number;
  onSelect: (view: AppView) => void;
}): React.JSX.Element {
  const Icon = item.icon;
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      // When collapsed the label is hidden — keep it reachable to assistive tech
      // and surface it as a hover tooltip.
      aria-label={
        collapsed
          ? `${item.label}${count > 0 ? `, ${count} waiting` : ''}`
          : undefined
      }
      title={collapsed ? item.label : undefined}
      onClick={() => onSelect(item.view)}
      className={cn(
        'relative flex w-full items-center rounded-md text-left text-sm font-medium outline-none transition-colors',
        'hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
        collapsed ? 'justify-center px-0 py-2' : 'gap-3 px-3 py-2',
        active
          ? 'bg-sidebar-accent text-sidebar-primary-strong'
          : 'text-sidebar-foreground/75',
      )}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {collapsed ? null : item.label}
      {count > 0 ? (
        <span
          data-slot="nav-count"
          className={cn(
            'rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums',
            collapsed ? 'absolute top-0.5 right-0.5' : 'ml-auto',
          )}>
          {count}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The app's persistent left navigation. The single home for switching between
 * the top-level surfaces (Chats, Teams, Stats, Settings). Collapses to an
 * icon-only rail — REMEMBERED across launches in `settings.json` — and
 * collapsed items expose their label as a tooltip + aria-label.
 *
 * It is NAVIGATION and nothing else now. The daemon status and the version sat
 * in a footer under a rule, and collapsed that footer shrank to a single green
 * pip alone under a line ("this little dot looks all alone") — a readout
 * with nothing to read it against. Both moved to the title bar, beside the
 * other things that describe the app as a whole rather than this column.
 */
export function NavRail({
  view,
  onNavigate,
  collapsed,
  hydrated,
  onToggleCollapsed,
  counts = {},
}: {
  view: AppView;
  onNavigate: (view: AppView) => void;
  /** What waits on the user, by destination. */
  counts?: Partial<Record<AppView, number>>;
  /**
   * Collapsed state, OWNED by the shell (`useSidebarCollapsed`).
   *
   * A prop rather than this component's own `useState` because the toggle that
   * flips it now lives in the title bar, above this column — two `useState`s
   * reading one setting would be two answers to one question, and the first
   * press would make them disagree.
   */
  collapsed: boolean;
  /** Whether the remembered width has been applied — see the hook. */
  hydrated: boolean;
  /**
   * Flip the width.
   *
   * The control is HERE, at the top of the rail, and not in the title bar it
   * briefly moved to: it acts on this column rather than on the window, so it
   * belongs to the column ("let's leave it in the menu itself, in the same
   * place it was"). Only the STATE is the shell's, because the width it sets
   * is what the title bar's divider has to line up with.
   */
  onToggleCollapsed: () => void;
}): React.JSX.Element {
  return (
    <nav
      className={cn(
        'flex shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar px-3 py-3',
        hydrated && 'transition-[width]',
      )}
      // From `shared/contracts.ts` because the title bar's divider is placed
      // from the same numbers — the band above has to end exactly on this
      // column's border, not near it.
      style={{
        width: collapsed ? RAIL_COLLAPSED_WIDTH : RAIL_EXPANDED_WIDTH,
      }}>
      {/* The rail's own top row: the app mark and the width toggle, which is
          where both were before the shell grew a title bar and where they went
          back to ("move the logo into the menu, and leave the collapse
          button in the menu itself looking the way it does now"). The mark
          belongs to the app rather than to the window, and the toggle acts on
          THIS column — so the band above keeps only what is about the window
          itself. Collapsed there is no room for both, and the toggle is the
          one that does something. */}
      <div
        className={cn(
          'mb-1 flex h-9 shrink-0 items-center',
          collapsed ? 'justify-center' : 'gap-2',
        )}>
        {collapsed ? null : <Logo size="nav" />}
        <button
          type="button"
          aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
          title={collapsed ? 'Expand menu' : 'Collapse menu'}
          onClick={onToggleCollapsed}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
            collapsed ? null : 'ml-auto',
          )}>
          {collapsed ? (
            <PanelLeftOpen aria-hidden="true" className="size-4" />
          ) : (
            <PanelLeftClose aria-hidden="true" className="size-4" />
          )}
        </button>
      </div>
      {PRIMARY_ITEMS.map((item) => (
        <NavButton
          key={item.view}
          item={item}
          active={view === item.view}
          collapsed={collapsed}
          count={counts[item.view] ?? 0}
          onSelect={onNavigate}
        />
      ))}

      <div className="mt-auto flex flex-col gap-1">
        {SECONDARY_ITEMS.map((item) => (
          <NavButton
            key={item.view}
            item={item}
            active={view === item.view}
            collapsed={collapsed}
            count={counts[item.view] ?? 0}
            onSelect={onNavigate}
          />
        ))}
      </div>
    </nav>
  );
}
