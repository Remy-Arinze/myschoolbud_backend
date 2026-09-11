import { personNameTokens, personNameWhere } from './person-name-filter';

describe('personNameWhere', () => {
  it('tokenizes a full name so Adaeze Okeke matches first+last', () => {
    expect(personNameTokens('Adaeze Okeke')).toEqual(['Adaeze', 'Okeke']);
    expect(personNameWhere('Adaeze Okeke')).toEqual({
      AND: [
        {
          OR: [
            { firstName: { contains: 'Adaeze', mode: 'insensitive' } },
            { lastName: { contains: 'Adaeze', mode: 'insensitive' } },
          ],
        },
        {
          OR: [
            { firstName: { contains: 'Okeke', mode: 'insensitive' } },
            { lastName: { contains: 'Okeke', mode: 'insensitive' } },
          ],
        },
      ],
    });
  });
});
