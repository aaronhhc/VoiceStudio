// Predefined reading passages for guided reference recording. Original text written for this project (no third-party licence).
// The passage text is used verbatim as the reference transcript, so the speaker must read it exactly as printed.
// Chinese passages are written in Taiwan Traditional Chinese (zh-TW). They double as the reference transcript, so they were checked against the
// ZipVoice and F5 text front ends (see docs/ux_scene2_f5_progress.md).
// Plain Chinese characters and punctuation only; no digits or Latin letters, so no ambiguous readings.
export const PASSAGES = [
  {id: 'en-1', lang: 'en', label: 'English — everyday', text: 'The morning train was quiet, so I opened my notebook and wrote down a few plans for the week. Then I made a cup of tea and watched the rain slowly fade away.'},
  {id: 'en-2', lang: 'en', label: 'English — conversational', text: 'Thanks for waiting. I checked the schedule again, and it looks like we can meet on Thursday afternoon, if that still works for everyone.'},
  {id: 'zh-1', lang: 'zh', label: '中文（繁體）— 日常', text: '今天早上天氣很好，我騎著腳踏車穿過安靜的小巷，順便在轉角的早餐店買了一杯熱豆漿。'},
  {id: 'zh-2', lang: 'zh', label: '中文（繁體）— 對話', text: '謝謝你耐心等候，我剛剛又確認了一次時間，看起來星期四下午大家都可以開會。'},
];
