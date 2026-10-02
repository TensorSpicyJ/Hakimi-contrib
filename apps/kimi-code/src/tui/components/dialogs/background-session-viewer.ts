/**
 * BackgroundSessionViewer — full-screen pi-tui viewer for a session this
 * process adopted from another session's handoff.
 *
 * Read-only: it shows the target project, the handed-off task's coarse status
 * and the session's own output. It deliberately does not reuse the task
 * browser's output viewer — a background session is a real session, not a
 * subagent or a background task — and closing it never touches the session.
 * Mounted by `BackgroundSessionsController` through the screen-takeover swap.
 */

import {
  Container,
  Key,
  matchesKey,
  type Terminal,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

const ELLIPSIS = '…';

export interface BackgroundSessionViewerProps {
  readonly sessionId: string;
  /** Project directory (plus title when the session has one). */
  readonly label: string;
  readonly status: string;
  readonly output: string;
  readonly onClose: () => void;
}

function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width, ELLIPSIS);
  return line + ' '.repeat(width - w);
}

function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  return padToWidth(s, width);
}

export class BackgroundSessionViewer extends Container implements Focusable {
  focused = false;

  private props: BackgroundSessionViewerProps;
  private readonly terminal: Terminal;
  /** Output split on '\n'. Replaced on `setProps` when `output` changes. */
  private lines: string[];
  /** Index of the topmost visible line. */
  private scrollTop = 0;

  constructor(props: BackgroundSessionViewerProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.lines = splitOutput(props.output);
  }

  /**
   * Update the shown snapshot. New output follows the tail when the user is
   * parked at the bottom; otherwise the scroll position is kept.
   */
  setProps(next: BackgroundSessionViewerProps): void {
    const previousOutput = this.props.output;
    const wasAtBottom = this.scrollTop >= this.maxScroll();
    this.props = next;
    if (next.output !== previousOutput) {
      this.lines = splitOutput(next.output);
      this.scrollTop = wasAtBottom
        ? this.maxScroll()
        : Math.min(this.scrollTop, this.maxScroll());
    }
    this.invalidate();
  }

  handleInput(data: string): void {
    const visible = this.viewableRows();
    const k = printableChar(data);

    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.props.onClose();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      this.scrollTo(this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      this.scrollTo(this.scrollTop + 1);
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl('u')) || k === ' ') {
      this.scrollTo(this.scrollTop - Math.max(1, visible - 1));
      return;
    }
    if (
      matchesKey(data, Key.pageDown) ||
      matchesKey(data, Key.ctrl('d')) ||
      data === '\u0006' /* C-f */
    ) {
      this.scrollTo(this.scrollTop + Math.max(1, visible - 1));
      return;
    }
    if (matchesKey(data, Key.home) || k === 'g') {
      this.scrollTo(0);
      return;
    }
    if (matchesKey(data, Key.end) || k === 'G') {
      this.scrollTo(this.maxScroll());
      return;
    }
  }

  override render(width: number): string[] {
    const rows = Math.max(3, this.terminal.rows);
    const bodyHeight = rows - 2;
    const header = this.renderHeader(width);
    const body = this.renderBody(width, bodyHeight);
    const footer = this.renderFooter(width, bodyHeight);
    return [header, ...body, footer];
  }

  private renderHeader(width: number): string {
    const title = currentTheme.boldFg('primary', ' Background session ');
    const id = currentTheme.boldFg('text', this.props.sessionId);
    const status = currentTheme.fg('accent', this.props.status);
    const label = currentTheme.fg('textMuted', this.props.label);
    return fitExactly(`${title}${id}  ${status}  ${label}`, width);
  }

  private renderBody(width: number, bodyHeight: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const max = this.maxScroll();
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, max));

    const viewRows = bodyHeight - 2;
    const top = currentTheme.fg('primary', '┌' + '─'.repeat(Math.max(0, width - 2)) + '┐');
    const bottom = currentTheme.fg('primary', '└' + '─'.repeat(Math.max(0, width - 2)) + '┘');

    const out: string[] = [top];
    for (let i = 0; i < viewRows; i++) {
      const raw = this.lines[this.scrollTop + i] ?? '';
      const inner = fitExactly(currentTheme.fg('text', raw), innerWidth);
      out.push(currentTheme.fg('primary', '│ ') + inner + currentTheme.fg('primary', ' │'));
    }
    out.push(bottom);
    return out;
  }

  private renderFooter(width: number, bodyHeight: number): string {
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);

    const total = this.lines.length;
    const viewRows = Math.max(1, bodyHeight - 2);
    const maxScroll = Math.max(0, total - viewRows);
    const percent = maxScroll === 0 ? 100 : Math.round((this.scrollTop / maxScroll) * 100);
    const position = currentTheme.fg(
      'textMuted',
      ` ${String(this.scrollTop + 1)}-${String(Math.min(total, this.scrollTop + viewRows))} / ${String(total)} (${String(percent)}%) `,
    );
    const keys =
      `${key('↑↓')} ${dim('line')}  ` +
      `${key('PgUp/PgDn')} ${dim('page')}  ` +
      `${key('g/G')} ${dim('top/bot')}  ` +
      `${key('Q/Esc')} ${dim('back to current session')}`;
    const left = ` ${keys}`;
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(position);
    if (leftW + 2 + rightW <= width) {
      return left + ' '.repeat(width - leftW - rightW) + position;
    }
    return fitExactly(left, width);
  }

  private maxScroll(): number {
    return Math.max(0, this.lines.length - this.viewableRows());
  }

  private viewableRows(): number {
    // header(1) + footer(1) + body borders(2)
    return Math.max(1, this.terminal.rows - 4);
  }

  private scrollTo(target: number): void {
    this.scrollTop = Math.max(0, Math.min(target, this.maxScroll()));
    this.invalidate();
  }
}

function splitOutput(output: string): string[] {
  return (output.length > 0 ? sanitizeShellOutput(output) : '[no output yet]').split('\n');
}
