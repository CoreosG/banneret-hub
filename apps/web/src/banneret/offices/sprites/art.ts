// Each row is one scanline. A period leaves the destination pixel untouched.
export const furniture = {
  floor: [
    `.......ss
.....ssffss
...ssffffffss
.ssffffssffffss
sffffssffffffffs
ssfsfffffffffsss
..sssffffffsss
....sssffsss
......ssss`,
    "..ss/.sffs/sffffs/.sffs/..ss",
    ".s/sss/.s",
  ],
  wall: [
    `..ii
.iwwii
iwffwwii
iwwfffwwii
iwwwwfffwwii
iwwwwwwfffwwii
iwwwwwwwwfffwwi
iwwwwwwwwwwffwi
iwwwwwwwwwwwwwi
.iiwwwwwwwwwwwi
...iiwwwwwwwwwi
.....iiwwwwwwwi
.......iiwwwwwi
.........iiwwwi
...........iiwi
.............ii`,
    "ii/iwii/iwwwii/iwwwwi/.iiwwi/...iii",
    "ss/.ss/..ss",
  ],
  desk: [
    `........ii
......iiwwii
....iiwwwwwwii
..iiwwwwwwwwwwii
iiwwwwwwwffwwwwwii
iisswwwffwwwwwssii
iisssswwwwwwsswwii
.iiisssswwsswwii.i
.iwiiisssswwii..si
.iwi..iissii....ii
.ii.....iwii
........iwii
........iii`,
    "...ww/..wwww/.wwwwww/sswwwss/s.sss.s/s..s..s/...s",
    "..w/.www/wwwww/..w",
  ],
  chair: [
    `....iii
...iaaaii
...iaaaaai
...iaasaai
...isaasai
...issaaai
...iissaaii
..iaaissiaai
.iaaaaaaaassi
..issaaasssi
....issssi
......ii
....iisiii
...ii....ii`,
    ".aaa/.asaa/.asaa/aaasa/.sss/..s/.sss",
    ".aa/.aa/aaa/.s",
  ],
  plant: [
    `.......gg
....gg.gGg
....gGggGg..gg
.gg..gGgGg.gGg
.gGgg.gGGggGg
..gGGg.gGgGg
....gGggGg
..iiwwiGii
..iwwwwwwi
...iwsssi
...iwsssi
....isssi
.....iii`,
    "..g/g.gg/ggGg/.gg/wwww/.ss",
    ".g/gGg/.w",
  ],
  whiteboard: [
    `..........iii
........iifffi
......iifffffi
....iifffggffi
..iifffggffffi
.ifffggfffaafi
.ifggfffaaffsi
.iffffaaafssii
.iffffffsssi.i
.iffffsssii..i
.ifisssii....ii
.iissii
.iii
.ii`,
    "....ss/..sffs/sffffs/sffsss/sss..s/s",
    "..s/.ss/sss",
  ],
  door: [
    `..........iii
........iiwwi
......iiwwssi
....iiwwsswsi
...iwwsswwwsi
...iwsswwwwsi
...iwswwsswsi
...iwswsffwsi
...iwswsffwsi
...iwswwsswsi
...iwswwwwfsi
...iwswwwwssi
...iwswwssii
...iwsssii
...issii
...ii`,
    "...ss/.ssws/swwws/swwfs/swwss/sss",
    ".ss/sws/sss",
  ],
  "room-sign": [
    `.........iii
.......iiaai
.....iiaafai
...iiaaffaai
..iaaffaaasi
..iaafaassii
..iaaassii
..iassii
..iiii`,
    "..aaa/aaaaf/afass/sss",
    ".aa/aaa",
  ],
  "meeting-link": [
    `.......aaaa
......affffa
.....affaaafa
.....affaaafa
......aaaffa
....aaaffa.a
...affaffa
..affaaafa
..affaaafa
...affffa
....aaaa`,
    "...aaa/..a..a/..aaaa/aaa/a.a/aaa",
    "..aa/.aa/aa",
  ],
} as const;

export const people = {
  jacket: `...iiii
..issssi
..isfffs
..isfifs
...sfffs
..iaasai
.iaaaasai
.ifaaasaf
..iaaasi
..issssi
..iss.is
..iss.is
..iii.iii`,
  tunic: `....iii
...isssi
..issffsi
..isffifi
..isfffsi
...iaaai
..iaaasai
..faaaaaf
..iaaaasi
.iaaaassi
...ss.ss
...ss.ss
...ii.iii`,
  hoodie: `...aaaa
..aasaas
..asfffs
..asfifs
...sfffs
..iaasai
.iafaasai
.iaaasasi
..fssssf
..issssi
..iss.is
..iii.iii`,
} as const;

export const robot = `......ii
......ai
...iiiiiiii
..isswwwwwwii
.iswwwffffwwwi
.iswwiiiiiiwwi
.iswwiiiiiiwwi
.iswwiiiiiiwwi
.iswwiiiiiiwwi
.iswwiiiiiiwwi
..isswwwwwwssi
....issssssii
..iiwwwwwwwii
..iswwaawwwsi
..iiwwwwwwwii
....isssssi
....ii..iii`;

export const signals = {
  working: ["ok", ".a../.aa./.aaa/.aa./.a.."],
  "waiting-on-you": ["warn", ".aa./.aa./.aa./..../.aa."],
  "waiting-on-someone-else": ["warn", "aaaa/.aa./.aa./aaaa"],
  "not-heard-from": ["muted", ".aa./a..a/..a./..../..a."],
  stopped: ["muted", "aaaa/aaaa/aaaa/aaaa"],
  "usage-limit": ["error", "...a/..aa/.aaa/aaaa"],
  available: ["ok", "...a/..a./a.a./.a.."],
  focusing: ["info", ".aa./a..a/a..a/.aa."],
  away: ["warn", "aa../a.../aa../.aaa"],
  off: ["muted", "...a/..a./.a../a..."],
} as const;
