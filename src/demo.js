export const titles = [
  {
    id: "1",
    title: "The Last Signal",
    subtitle: "2026 · Movie",
    type: "movie",
    art: "signal",
    tagline: "SOME THINGS SHOULD STAY LOST",
  },
  {
    id: "2",
    title: "North of Nowhere",
    subtitle: "Season 2 / 4 Episodes",
    type: "tv",
    art: "north",
    tagline: "THE LONG WAY HOME",
  },
  {
    id: "3",
    title: "Orbit Nine",
    subtitle: "2026 · Movie",
    type: "movie",
    art: "orbit",
    tagline: "BEYOND THE KNOWN",
  },
  {
    id: "4",
    title: "After Hours",
    subtitle: "Season 1 / 6 Episodes",
    type: "tv",
    art: "hours",
    tagline: "THE CITY NEVER TELLS",
  },
  {
    id: "5",
    title: "Wild Coast",
    subtitle: "2025 · Movie",
    type: "movie",
    art: "coast",
    tagline: "WHERE THE LAND ENDS",
  },
  {
    id: "6",
    title: "Paper Moons",
    subtitle: "2026 · Movie",
    type: "movie",
    art: "moons",
    tagline: "A LITTLE LESS ORDINARY",
  },
];

titles.forEach((item, i) => {
  item.added = `2026-10-${String(7 - Math.floor(i / 2)).padStart(2, "0")}T${String(20 - i).padStart(2, "0")}:14:00`;
});

export function demoEvents(start, end) {
  const events = [];
  const day = new Date(start);
  while (day < new Date(end)) {
    const n = day.getUTCDate();
    const date = day.toISOString().slice(0, 10);
    const add = (
      type,
      title,
      subtitle,
      status,
      time = "20:00",
      monitored = true,
    ) =>
      events.push({
        id: `${date}-${events.length}`,
        type,
        title,
        subtitle,
        status,
        date: `${date}T${time}:00`,
        demoLocal: true,
        monitored,
        premiere: type === "tv" && /S[0-9]+E01/.test(subtitle),
        year: 2026,
        network: "Sample Network",
        runtime: 48,
        genres: type === "tv" ? ["Adventure", "Drama"] : [],
        overview: "A quiet discovery changes everything for a small community. Old friendships are tested as the story unfolds.",
      });
    if ([2, 7, 14, 21, 28].includes(n)) {
      add(
        "tv",
        "North of Nowhere",
        `S02E${String(Math.floor(n / 7) + 4).padStart(2, "0")} · The crossing`,
        n === 7 ? "available" : "upcoming",
      );
      add(
        "tv",
        "After Hours",
        "S01E06 · Quiet streets",
        n === 7 ? "missing" : "upcoming",
        "21:30",
        false,
      );
    }
    if ([6, 13, 20, 27].includes(n))
      add(
        "movie",
        "The Last Signal",
        "Lantern Pictures",
        n === 6 ? "available" : "unreleased",
      );
    if ([8, 15, 22].includes(n)) {
      add(
        "movie",
        "Orbit Nine",
        "Meridian Studios",
        "cinema",
      );
      add(
        "tv",
        "Small Town Radio",
        "S03E01 · A voice in the static",
        "upcoming",
        "22:00",
      );
    }
    if ([4, 11, 18, 25].includes(n))
      add("tv", "Wild Coast", "S01E03 · The tide turns", "upcoming", "20:00");
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return events;
}

export function demoSearch(query) {
  const q = String(query || "").toLowerCase();
  const pool = [
    {
      id: 101,
      mediaType: "movie",
      title: "The Last Signal",
      year: "2026",
      poster: "signal",
      overview:
        "A deep-space crew answers a transmission that should not exist.",
      availability: 5,
      requested: false,
    },
    {
      id: 102,
      mediaType: "tv",
      title: "North of Nowhere",
      year: "2025",
      poster: "north",
      overview: "Two estranged siblings hike the long way home.",
      availability: 2,
      requested: true,
    },
    {
      id: 103,
      mediaType: "movie",
      title: "Orbit Nine",
      year: "2026",
      poster: "orbit",
      overview: "Cartographers chart the ninth orbit.",
      availability: null,
      requested: false,
    },
    {
      id: 104,
      mediaType: "tv",
      title: "After Hours",
      year: "2024",
      poster: "hours",
      overview: "Night-shift stories from a city that never tells.",
      availability: 4,
      requested: false,
    },
  ];
  return pool.filter((item) => !q || item.title.toLowerCase().includes(q));
}

export const demoRequests = [
  {
    id: 1,
    title: "The Last Signal",
    mediaType: "movie",
    status: 2,
    availability: 3,
    requestedBy: "Demo viewer",
    createdAt: "2026-10-06T19:00:00Z",
  },
  {
    id: 2,
    title: "North of Nowhere",
    mediaType: "tv",
    status: 1,
    availability: 2,
    requestedBy: "Demo viewer",
    createdAt: "2026-10-05T21:00:00Z",
  },
  {
    id: 3,
    title: "Wild Coast",
    mediaType: "movie",
    status: 2,
    availability: 5,
    requestedBy: "Demo viewer",
    createdAt: "2026-10-02T18:00:00Z",
  },
];
