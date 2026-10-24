/** How long ago, in words an agent reads at a glance: "just now", "4 min ago", "2 h ago". */
export const ago = (iso: string, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} d ago`;
};
