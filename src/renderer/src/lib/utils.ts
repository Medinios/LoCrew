import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge has to know the design system's own scale names, or it takes
 * `text-nav` for a text colour and drops it next to `text-ink-muted`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['2xs', 'nav', 'body', 'title'] }],
      shadow: [{ shadow: ['panel', 'composer', 'composer-focus', 'popover', 'dialog', 'focus'] }],
      'tracking': [{ tracking: ['label'] }],
      'z': [{ z: ['header', 'dropdown', 'overlay', 'toast', 'tooltip'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** "3:25 PM" in the user's locale. */
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDay(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

/** Time today, otherwise a short date: for lists that span days. */
export function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  if (date.toDateString() === new Date().toDateString()) return formatTime(timestamp);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** One letter for a single name, two for a full name: what fits a small circle. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return ((parts[0] ?? '')[0] ?? '?').toUpperCase();
  return `${(parts[0] ?? '')[0] ?? ''}${(parts[1] ?? '')[0] ?? ''}`.toUpperCase();
}

/**
 * Midnight or white, whichever reads better on a `#rrggbb` colour: light
 * accents (teal, mint, amber) take dark initials, deep ones take white.
 */
export function readableTextOn(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return '#FFFFFF';
  const value = parseInt(match[1]!, 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  // Contrast against white vs. against #111827 (luminance ~0.012).
  return (1.05 / (luminance + 0.05)) >= ((luminance + 0.05) / 0.062) ? '#FFFFFF' : '#111827';
}

/** Last path segment, for either separator. */
export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Normalises a name the way the main process resolves @mentions. */
export function mentionKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s._-]/g, '');
}

/** Markdown reduced to a single line of plain text, for previews. */
export function plainPreview(markdown: string, max = 180): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
