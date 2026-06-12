import { describe, it, expect } from 'vitest'
import { parseSrt, parseAss, parseSubtitle } from './subtitle'

describe('parseSrt', () => {
  it('parses basic SRT', () => {
    const content = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,000 --> 00:00:08,000
How are you
`
    const result = parseSrt(content)
    expect(result.segments).toEqual(['Hello world', 'How are you'])
  })

  it('handles multi-line subtitle text', () => {
    const content = `1
00:00:01,000 --> 00:00:04,000
Line one
Line two

2
00:00:05,000 --> 00:00:08,000
Single line
`
    const result = parseSrt(content)
    expect(result.segments).toEqual(['Line one\nLine two', 'Single line'])
  })

  it('handles Windows line endings', () => {
    const content = "1\r\n00:00:01,000 --> 00:00:04,000\r\nHello\r\n\r\n2\r\n00:00:05,000 --> 00:00:08,000\r\nWorld\r\n"
    const result = parseSrt(content)
    expect(result.segments).toEqual(['Hello', 'World'])
  })

  it('returns empty for blank input', () => {
    expect(parseSrt('').segments).toEqual([])
    expect(parseSrt('  \n  ').segments).toEqual([])
  })

  it('skips malformed entries', () => {
    const content = `1
not a time line
Hello

2
00:00:05,000 --> 00:00:08,000
World
`
    const result = parseSrt(content)
    expect(result.segments).toEqual(['World'])
  })

  it('rebuilds SRT with translations', () => {
    const content = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,000 --> 00:00:08,000
How are you
`
    const result = parseSrt(content)
    const rebuilt = result.rebuild(['你好世界', '你好吗'])
    expect(rebuilt).toBe(`1
00:00:01,000 --> 00:00:04,000
你好世界

2
00:00:05,000 --> 00:00:08,000
你好吗
`)
  })

  it('rebuilds multi-line entries', () => {
    const content = `1
00:00:01,000 --> 00:00:04,000
Line one
Line two
`
    const result = parseSrt(content)
    const rebuilt = result.rebuild(['第一行\n第二行'])
    expect(rebuilt).toContain('第一行\n第二行')
  })
})

describe('parseAss', () => {
  const basicAss = `[Script Info]
Title: Test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello world
Dialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,How are you`

  it('parses basic ASS dialogues', () => {
    const result = parseAss(basicAss)
    expect(result.segments).toEqual(['Hello world', 'How are you'])
  })

  it('strips inline tags from text', () => {
    const content = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\b1}Bold{\\b0} text`
    const result = parseAss(content)
    expect(result.segments).toEqual(['Bold text'])
  })

  it('preserves leading tags in rebuild', () => {
    const content = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\pos(320,50)}Hello world`
    const result = parseAss(content)
    expect(result.segments).toEqual(['Hello world'])
    const rebuilt = result.rebuild(['你好世界'])
    expect(rebuilt).toContain('{\\pos(320,50)}你好世界')
  })

  it('converts \\N to newlines in segments', () => {
    const content = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Line one\\NLine two`
    const result = parseAss(content)
    expect(result.segments).toEqual(['Line one\nLine two'])
  })

  it('converts newlines back to \\N in rebuild', () => {
    const content = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Line one\\NLine two`
    const result = parseAss(content)
    const rebuilt = result.rebuild(['第一行\n第二行'])
    expect(rebuilt).toContain('第一行\\N第二行')
  })

  it('rebuilds non-dialogue lines unchanged', () => {
    const result = parseAss(basicAss)
    const rebuilt = result.rebuild(['你好世界', '你好吗'])
    expect(rebuilt).toContain('[Script Info]')
    expect(rebuilt).toContain('Title: Test')
    expect(rebuilt).toContain('[V4+ Styles]')
    expect(rebuilt).toContain('Style: Default,Arial,20')
  })

  it('handles Windows line endings', () => {
    const content = "[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello"
    const result = parseAss(content)
    expect(result.segments).toEqual(['Hello'])
  })

  it('skips empty dialogue text', () => {
    const content = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,
Dialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,Hello`
    const result = parseAss(content)
    expect(result.segments).toEqual(['Hello'])
  })

  it('handles text with commas', () => {
    const content = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello, world, how are you`
    const result = parseAss(content)
    expect(result.segments).toEqual(['Hello, world, how are you'])
  })
})

describe('parseSubtitle', () => {
  it('routes .srt to parseSrt', () => {
    const content = `1\n00:00:01,000 --> 00:00:04,000\nHello\n`
    const result = parseSubtitle(content, 'video.srt')
    expect(result.segments).toEqual(['Hello'])
  })

  it('routes .ass to parseAss', () => {
    const content = `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello`
    const result = parseSubtitle(content, 'video.ass')
    expect(result.segments).toEqual(['Hello'])
  })

  it('routes .ssa to parseAss', () => {
    const content = `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello`
    const result = parseSubtitle(content, 'video.ssa')
    expect(result.segments).toEqual(['Hello'])
  })

  it('case-insensitive extension matching', () => {
    const content = `1\n00:00:01,000 --> 00:00:04,000\nHello\n`
    const result = parseSubtitle(content, 'VIDEO.SRT')
    expect(result.segments).toEqual(['Hello'])
  })
})
