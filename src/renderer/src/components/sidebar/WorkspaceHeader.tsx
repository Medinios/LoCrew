import * as Menu from '@radix-ui/react-dropdown-menu';
import { Bot, ChevronsUpDown, CircleUserRound, Hash, Info, Plug, Plus, Server, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand/BrandMark';
import { SHIP } from '@/lib/lexicon';
import { useApp } from '@/stores/app';

/**
 * The top of the sidebar: the mark, the workspace's name, and a menu of the
 * things you do to the workspace as a whole.
 */
export function WorkspaceHeader({ onNewChannel, onAddAgent }: { onNewChannel(): void; onAddAgent(): void }) {
  const settings = useApp((s) => s.settings);
  const openSettings = useApp((s) => s.openSettings);
  // A workspace the user named shows "LoCrew" underneath; an unnamed one is
  // LoCrew itself, with the tagline underneath instead.
  const custom = settings?.workspaceName?.trim();
  const named = !!custom && custom !== SHIP.appName;
  const name = named ? custom : SHIP.appName;

  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          type="button"
          aria-label={`${name} workspace menu`}
          className="group flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-fast hover:bg-shell-hover data-[state=open]:bg-shell-hover"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-shell-line bg-shell-raised">
            <BrandMark size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-nav font-semibold text-ink">{name}</span>
            <span className="block truncate text-2xs text-ink-faint">{named ? SHIP.appName : SHIP.tagline}</span>
          </span>
          <ChevronsUpDown size={14} strokeWidth={2} className="shrink-0 text-ink-faint transition-colors group-hover:text-ink-muted" />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={6}
          className="z-dropdown w-[236px] animate-pop-in rounded-lg border border-shell-line bg-shell-raised p-1 text-ink shadow-[0_12px_32px_-12px_rgb(0_0_0/0.6)]"
        >
          <Menu.Label className="px-2 pb-1.5 pt-1 text-2xs font-semibold uppercase tracking-label text-ink-faint">
            {name}
          </Menu.Label>
          <Item icon={<Hash size={14} />} onSelect={onNewChannel}>
            {SHIP.actions.newChannel}
          </Item>
          <Item icon={<Plus size={14} />} onSelect={onAddAgent}>
            {SHIP.actions.createAgent}
          </Item>
          <Menu.Separator className="my-1 h-px bg-shell-line" />
          <Item icon={<SlidersHorizontal size={14} />} onSelect={() => openSettings('general')}>
            Workspace settings
          </Item>
          <Item icon={<Plug size={14} />} onSelect={() => openSettings('providers')}>
            AI providers
          </Item>
          <Item icon={<Server size={14} />} onSelect={() => openSettings('mcp')}>
            MCP servers
          </Item>
          <Item icon={<Bot size={14} />} onSelect={() => useApp.getState().openView('agents')}>
            Agent directory
          </Item>
          <Menu.Separator className="my-1 h-px bg-shell-line" />
          <Item icon={<CircleUserRound size={14} />} onSelect={() => openSettings('profile')}>
            Your profile
          </Item>
          <Item icon={<Info size={14} />} onSelect={() => openSettings('about')}>
            About {SHIP.appName}
          </Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Item({ icon, onSelect, children }: { icon: ReactNode; onSelect(): void; children: ReactNode }) {
  return (
    <Menu.Item
      onSelect={onSelect}
      className="flex h-8 cursor-default select-none items-center gap-2.5 rounded-md px-2 text-nav text-ink-soft outline-none transition-colors duration-fast data-[highlighted]:bg-shell-active data-[highlighted]:text-ink"
    >
      <span className="text-ink-faint">{icon}</span>
      {children}
    </Menu.Item>
  );
}
