import { describe, expect, it } from 'vitest';
import {
  detectImageType,
  displayName,
  MAX_IMAGE_BYTES,
  prepareImages,
} from '../../src/main/attachments/images.js';
import { rejectedFeature } from '../../src/main/providers/http.js';
import { toAnthropicMessages } from '../../src/main/providers/anthropic.js';
import { acceptsImageInput } from '../../src/main/runtimes/a2a.js';
import { claudeUserMessage } from '../../src/main/runtimes/claude-code.js';
import { codexInput } from '../../src/main/runtimes/codex.js';
import { transcriptToMessages, withoutImages } from '../../src/main/runtimes/conversation.js';
import type { ContextImage, TranscriptEntry } from '../../src/main/runtimes/types.js';
import { PNG_1PX } from '../support/images.js';

const bytes = (...values: number[]) => new Uint8Array([...values, ...new Array(16).fill(0)]);

describe('recognising images by their bytes', () => {
  it('knows PNG, JPEG, GIF and WebP from their signatures', () => {
    expect(detectImageType(Buffer.from(PNG_1PX, 'base64'))).toBe('image/png');
    expect(detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(detectImageType(Buffer.from('GIF89a\x01\x00', 'latin1'))).toBe('image/gif');
    expect(detectImageType(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('image/webp');
  });

  it('refuses SVG, and a text file whatever it is called', () => {
    expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectImageType(Buffer.from('not really a png'))).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
  });

  it('keeps names for display only, stripped of paths and with the real extension', () => {
    expect(displayName('C:\\Users\\me\\Desktop\\shot.jpg', 'image/png')).toBe('shot.png');
    expect(displayName('../../etc/passwd', 'image/png')).toBe('passwd.png');
    expect(displayName('bad\u0000name.png', 'image/png')).toBe('badname.png');
    expect(displayName('', 'image/webp')).toBe('image.webp');
  });
});

describe('checking what the renderer sent', () => {
  it('accepts a real image and detects its type', () => {
    const [image] = prepareImages([{ name: 'photo.jpg', data: PNG_1PX }]);
    expect(image).toMatchObject({ mimeType: 'image/png', name: 'photo.png' });
  });

  it('refuses too many images, oversized ones, and anything that is not an image', () => {
    expect(() => prepareImages(Array.from({ length: 9 }, () => ({ name: 'a.png', data: PNG_1PX })))).toThrow(/at most 8/);
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0).toString('base64');
    expect(() => prepareImages([{ name: 'big.png', data: big }])).toThrow(/larger than/);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    expect(() => prepareImages([{ name: 'x.svg', data: svg }])).toThrow(/not a PNG, JPEG, GIF or WebP/);
  });
});

const image = (name: string, messageId = 'msg:1'): ContextImage => ({ messageId, path: `/data/${name}`, mimeType: 'image/png', name });

describe('handing images to each runtime', () => {
  it('Claude Code: the prompt text, then base64 image blocks', () => {
    const message = claudeUserMessage('Look at this', [{ ...image('shot.png'), bytes: Buffer.from(PNG_1PX, 'base64') }]);
    expect(message).toMatchObject({ type: 'user', parent_tool_use_id: null, message: { role: 'user' } });
    expect(message.message.content).toEqual([
      { type: 'text', text: 'Look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } },
    ]);
  });

  it('Codex: text plus local image files, naming any that have gone missing', () => {
    expect(codexInput('Hi', [], () => true)).toBe('Hi');
    expect(codexInput('Hi', [image('a.png'), image('b.png')], (p) => p.endsWith('a.png'))).toEqual([
      { type: 'text', text: 'Hi\n\n[This image is no longer available: b.png]' },
      { type: 'local_image', path: '/data/a.png' },
    ]);
  });

  it('Anthropic API: image blocks in the user turn', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', mimeType: 'image/png', data: PNG_1PX }] },
    ]);
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } },
    ]);
  });

  it('A2A: only to agents whose card accepts image input', () => {
    expect(acceptsImageInput({ defaultInputModes: ['text/plain', 'image/png'], skills: [] })).toBe(true);
    expect(acceptsImageInput({ defaultInputModes: ['text/plain'], skills: [{ inputModes: ['image/*'] }] as never })).toBe(true);
    expect(acceptsImageInput({ defaultInputModes: ['text/plain'], skills: [] })).toBe(false);
  });

  it('recognises a provider refusing images', () => {
    expect(rejectedFeature('Invalid content type. image_url is only supported by certain models.')).toBe('vision');
    expect(rejectedFeature('This model does not support image input')).toBe('vision');
    expect(rejectedFeature('tools are not supported')).toBe('tools');
  });
});

describe('stateless models: images in the rebuilt conversation', () => {
  const entry = (id: string, body: string, images: ContextImage[] = [], isSelf = false): TranscriptEntry => ({
    id,
    senderType: isSelf ? 'agent' : 'human',
    senderId: isSelf ? 'agent:1' : 'user:local',
    senderName: isSelf ? 'Scout' : 'Human operator',
    isSelf,
    addressedToSelf: !isSelf,
    kind: 'chat',
    body,
    images,
    createdAt: 1,
  });

  it('sends this turn\'s images and only names earlier ones', () => {
    const earlier = image('old.png', 'msg:1');
    const current = image('new.png', 'msg:3');
    const messages = transcriptToMessages(
      [entry('msg:1', 'First', [earlier]), entry('msg:2', 'Seen it.', [], true), entry('msg:3', 'And this?', [current])],
      100_000,
      { data: new Map([[current.path, { mimeType: 'image/png', data: PNG_1PX }]]), canView: true },
    );
    expect(messages[0]).toEqual({ role: 'user', content: '[Human operator → you]: First\n[Attached image: old.png]' });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '[Human operator → you]: And this?\n[Attached image: new.png]' },
        { type: 'image', mimeType: 'image/png', data: PNG_1PX },
      ],
    });
  });

  it('tells a model that cannot view images, instead of sending them', () => {
    const current = image('new.png', 'msg:1');
    const [message] = transcriptToMessages([entry('msg:1', 'See?', [current])], 100_000, {
      data: new Map([[current.path, { mimeType: 'image/png', data: PNG_1PX }]]),
      canView: false,
    });
    expect(typeof message!.content).toBe('string');
    expect(message!.content).toContain('you cannot view images');
  });

  it('strips images from a conversation when a provider refuses them mid-run', () => {
    const stripped = withoutImages([
      { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', mimeType: 'image/png', data: PNG_1PX }] },
    ]);
    expect(stripped).toEqual([{ role: 'user', content: 'Look\n\n[An image was attached here, but this model cannot view images.]' }]);
  });
});
