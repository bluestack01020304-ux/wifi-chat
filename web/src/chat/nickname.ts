const ADJECTIVES = [
  "졸린", "배고픈", "신난", "조용한", "용감한", "느긋한", "수줍은", "씩씩한",
  "다정한", "엉뚱한", "부지런한", "포근한", "반짝이는", "궁금한", "튼튼한", "날쌘",
];
const ANIMALS = [
  "고양이", "강아지", "펭귄", "수달", "다람쥐", "토끼", "부엉이", "판다",
  "여우", "거북이", "고래", "햄스터", "너구리", "코알라", "참새", "돌고래",
];

const pick = <T>(list: T[], random: () => number) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];

/** An automatic nickname, "<형용사> <동물>". Kept in memory only. */
export function makeNickname(random: () => number): string {
  return `${pick(ADJECTIVES, random)} ${pick(ANIMALS, random)}`;
}
