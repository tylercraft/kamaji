// When each PHP, MySQL and MariaDB release line stops getting security fixes, from php.net and
// each vendor. Kept by hand: recheck the sources and update `checked`. Kamaji raises a digest
// issue when this hasn't been checked in 6 months (endOfLife/check.ts). A line that isn't here
// is unknown on the site page, never "supported".

export const END_OF_LIFE = {
  checked: '2026-11-11',
  sources: {
    php: 'https://www.php.net/supported-versions.php and https://www.php.net/eol.php: security support until',
    mariadb: 'https://mariadb.org/about/#maintenance-policy: community end of maintenance',
    mysql:
      "https://www.mysql.com/support/eol-notice.html: date the release moved to Sustaining Support. 8.4 and 9.x not listed yet: Oracle's lifetime support pages refused the fetch, so they're unknown rather than guessed.",
  },
  php: {
    '5.6': '2018-12-31',
    '7.0': '2019-01-10',
    '7.1': '2019-12-01',
    '7.2': '2020-11-30',
    '7.3': '2021-12-06',
    '7.4': '2022-11-28',
    '8.0': '2023-11-26',
    '8.1': '2025-12-31',
    '8.2': '2026-12-31',
    '8.3': '2027-12-31',
    '8.4': '2028-12-31',
    '8.5': '2029-12-31',
  },
  mysql: {
    '5.7': '2023-10-25',
    '8.0': '2026-04-21',
  },
  mariadb: {
    '5.5': '2020-04-11',
    '10.0': '2019-03-31',
    '10.1': '2020-10-17',
    '10.2': '2022-05-23',
    '10.3': '2023-05-25',
    '10.4': '2024-06-18',
    '10.5': '2025-06-24',
    '10.6': '2026-07-06',
    '10.11': '2028-02-16',
    '11.4': '2029-05-29',
    '11.8': '2028-06-04',
    '12.3': '2029-06-12',
  },
} as const satisfies {
  checked: string;
  sources: Record<string, string>;
  php: Record<string, string>;
  mysql: Record<string, string>;
  mariadb: Record<string, string>;
};
