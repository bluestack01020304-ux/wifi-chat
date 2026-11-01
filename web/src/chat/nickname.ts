// 40 × 40 = 1600 combinations; the host numbers any that still collide.
const ADJECTIVES = [
  "졸린", "배고픈", "신난", "조용한", "용감한", "느긋한", "수줍은", "씩씩한",
  "다정한", "엉뚱한", "부지런한", "포근한", "반짝이는", "궁금한", "튼튼한", "날쌘",
  "명랑한", "차분한", "상냥한", "재빠른", "든든한", "말랑한", "새침한", "느린",
  "똑똑한", "귀여운", "의젓한", "활발한", "소심한", "반가운", "꼼꼼한", "푸근한",
  "산뜻한", "느릿한", "깜찍한", "늠름한", "당당한", "얌전한", "호기심많은", "행복한",
];
const ANIMALS = [
  "고양이", "강아지", "펭귄", "수달", "다람쥐", "토끼", "부엉이", "판다",
  "여우", "거북이", "고래", "햄스터", "너구리", "코알라", "참새", "돌고래",
  "기린", "사슴", "오리", "병아리", "물개", "알파카", "미어캣", "고슴도치",
  "하마", "코끼리", "얼룩말", "다람쥐원숭이", "두더지", "청설모", "앵무새", "까치",
  "오소리", "라쿤", "카피바라", "북극곰", "아기곰", "올빼미", "해달", "치타",
];

const pick = <T>(list: T[], random: () => number) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];

/** An automatic nickname, "<형용사> <동물>". Kept in memory only. */
export function makeNickname(random: () => number): string {
  return `${pick(ADJECTIVES, random)} ${pick(ANIMALS, random)}`;
}
