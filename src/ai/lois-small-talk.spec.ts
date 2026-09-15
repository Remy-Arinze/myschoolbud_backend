import { isLoisSmallTalk, smallTalkReply } from './lois-small-talk';

describe('isLoisSmallTalk', () => {
  it('accepts greetings, thanks, and identity asks', () => {
    expect(isLoisSmallTalk('Hi')).toBe(true);
    expect(isLoisSmallTalk('hello!')).toBe(true);
    expect(isLoisSmallTalk('Hey Lois')).toBe(true);
    expect(isLoisSmallTalk('good morning')).toBe(true);
    expect(isLoisSmallTalk('thanks')).toBe(true);
    expect(isLoisSmallTalk('Thank you so much')).toBe(true);
    expect(isLoisSmallTalk('how are you?')).toBe(true);
    expect(isLoisSmallTalk('who are you')).toBe(true);
    expect(isLoisSmallTalk('what can you do')).toBe(true);
  });

  it('rejects school tasks mixed with a greeting', () => {
    expect(isLoisSmallTalk('Hi, who owes fees?')).toBe(false);
    expect(isLoisSmallTalk('Hello, who is in JSS 1 A?')).toBe(false);
  });

  it('never treats HITL / apply confirmations as small talk', () => {
    expect(isLoisSmallTalk('ok')).toBe(false);
    expect(isLoisSmallTalk('yes')).toBe(false);
    expect(isLoisSmallTalk('yeah')).toBe(false);
    expect(isLoisSmallTalk('apply')).toBe(false);
    expect(isLoisSmallTalk('apply all')).toBe(false);
    expect(isLoisSmallTalk('go ahead')).toBe(false);
    expect(isLoisSmallTalk('do it')).toBe(false);
    expect(isLoisSmallTalk('save')).toBe(false);
    expect(isLoisSmallTalk('please')).toBe(false);
    expect(isLoisSmallTalk('Hi', { interrupted: true })).toBe(false);
  });

  it('never treats capability writes as small talk', () => {
    expect(isLoisSmallTalk("Take Chioma's school fees")).toBe(false);
    expect(isLoisSmallTalk('hire new staff please')).toBe(false);
  });
});

describe('smallTalkReply', () => {
  it('greets with name and school', () => {
    expect(smallTalkReply({ firstName: 'Arinze', schoolName: 'Beulah High', userMessage: 'Hi' })).toMatch(
      /Hi Arinze/,
    );
    expect(smallTalkReply({ firstName: 'Arinze', schoolName: 'Beulah High', userMessage: 'Hi' })).toMatch(
      /Beulah High/,
    );
  });

  it('acknowledges thanks', () => {
    expect(smallTalkReply({ firstName: 'Ada', userMessage: 'thanks' })).toMatch(/welcome/i);
  });
});
