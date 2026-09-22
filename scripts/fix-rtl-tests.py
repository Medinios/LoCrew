"""Points the direction assertions at the message container, not its text."""

import io

PATH = 'tests/renderer/rtl-rendering.test.tsx'

PAIRS = [
    (
        """  it('renders a Hebrew message right-to-left', () => {
    render(<MessageItem message={message('שלום, מה מצב המשימה?')} />);
    expect(bodyOf('שלום, מה מצב המשימה?').getAttribute('dir')).toBe('rtl');
  });""",
        """  it('renders a Hebrew message right-to-left', () => {
    const { container } = render(<MessageItem message={message('שלום, מה מצב המשימה?')} />);
    expect(bodyOf(container).getAttribute('dir')).toBe('rtl');
  });""",
    ),
    (
        """  it('renders an English message left-to-right', () => {
    render(<MessageItem message={message('What is the status of the task?')} />);
    expect(bodyOf('What is the status of the task?').getAttribute('dir')).toBe('ltr');
  });""",
        """  it('renders an English message left-to-right', () => {
    const { container } = render(
      <MessageItem message={message('What is the status of the task?')} />,
    );
    expect(bodyOf(container).getAttribute('dir')).toBe('ltr');
  });""",
    ),
    (
        """  it('keeps a Hebrew message RTL despite a leading mention', () => {
    const body = '@Roger למה התיאום ביניכם סגור?';
    render(<MessageItem message={message(body)} />);
    expect(bodyOf(body).getAttribute('dir')).toBe('rtl');
  });""",
        """  it('keeps a Hebrew message RTL despite a leading mention', () => {
    const { container } = render(
      <MessageItem message={message('@Roger למה התיאום ביניכם סגור?')} />,
    );
    expect(bodyOf(container).getAttribute('dir')).toBe('rtl');
  });""",
    ),
    (
        """  it('marks an error message with its own direction', () => {
    const body = 'ההרצה נכשלה בגלל שגיאת הרשאות';
    render(
      <MessageItem message={{ ...message(body), kind: 'execution_error' as const }} />,
    );
    expect(bodyOf(body).getAttribute('dir')).toBe('rtl');
  });""",
        """  it('marks an error message with its own direction', () => {
    const body = 'ההרצה נכשלה בגלל שגיאת הרשאות';
    render(<MessageItem message={{ ...message(body), kind: 'execution_error' as const }} />);
    expect(screen.getByText(body).getAttribute('dir')).toBe('rtl');
  });""",
    ),
    (
        """  it('marks a system notice with its own direction', () => {
    const body = 'נעצר כאן: הגעת למכסת ההודעות';
    render(<MessageItem message={{ ...message(body), kind: 'limit_notice' as const }} />);
    expect(bodyOf(body).getAttribute('dir')).toBe('rtl');
  });""",
        """  it('marks a system notice with its own direction', () => {
    const body = 'נעצר כאן: הגעת למכסת ההודעות';
    render(<MessageItem message={{ ...message(body), kind: 'limit_notice' as const }} />);
    expect(screen.getByText(body).getAttribute('dir')).toBe('rtl');
  });""",
    ),
    (
        """  it('gives each message its own direction in one transcript', () => {
    seed([
      message('Build the authentication endpoints.', 'msg:1'),
      message('קיבלתי, מתחיל לעבוד על זה', 'msg:2'),
    ]);
    render(<ChatView conversationId={CONVERSATION.id} />);

    expect(bodyOf('Build the authentication endpoints.').getAttribute('dir')).toBe('ltr');
    expect(bodyOf('קיבלתי, מתחיל לעבוד על זה').getAttribute('dir')).toBe('rtl');
  });""",
        """  it('gives each message its own direction in one transcript', () => {
    seed([
      message('Build the authentication endpoints.', 'msg:1'),
      message('קיבלתי, מתחיל לעבוד על זה', 'msg:2'),
    ]);
    const { container } = render(<ChatView conversationId={CONVERSATION.id} />);

    const bodies = [...container.querySelectorAll('.prose-message')];
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.getAttribute('dir')).toBe('ltr');
    expect(bodies[1]?.getAttribute('dir')).toBe('rtl');
  });""",
    ),
]

text = io.open(PATH, encoding='utf-8').read()
for old, new in PAIRS:
    assert old in text, f'not found -> {old[:60]}'
    text = text.replace(old, new)
io.open(PATH, 'w', encoding='utf-8').write(text)
print('rtl tests retargeted')
