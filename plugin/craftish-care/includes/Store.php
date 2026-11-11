<?php
/**
 * Everything the plugin keeps, all in its own options. Only the two public keys autoload; the
 * rest is stored with autoload off so it never weighs on the site's page loads.
 */

namespace CraftishCare;

defined( 'ABSPATH' ) || exit;

final class Store {
	const REPORT_KEY   = 'craftish_care_report_key';
	const UPDATE_KEY   = 'craftish_care_update_key';
	const DISCONNECTED = 'craftish_care_disconnected';
	const LOG          = 'craftish_care_log';
	const REFUSALS     = 'craftish_care_refusals';
	const REFRESHED    = 'craftish_care_refreshed';
	const RELEASE_KEY  = 'craftish_care_release_key';
	const RELEASE      = 'craftish_care_release';
	const JOBS         = 'craftish_care_jobs';
	const LOCK         = 'craftish_care_lock';
	const NONCE_PREFIX = 'craftish_care_n_';

	const LOG_SIZE  = 200;
	const NONCE_TTL = 900; // 15 minutes: longer than the 300-second window either side of now.
	const JOBS_KEPT = 20;
	const LOCK_TTL  = 900; // One job at a time; a lock older than 15 minutes is a run that died.

	/** Every option this plugin may write, for uninstall. Nonces are matched by prefix. */
	const OPTIONS = array( self::REPORT_KEY, self::UPDATE_KEY, self::DISCONNECTED, self::LOG, self::REFUSALS, self::REFRESHED, self::RELEASE_KEY, self::RELEASE, self::JOBS, self::LOCK );

	/**
	 * A key from the keys file: an id like "r1" and a base64 Ed25519 public key.
	 *
	 * @return array{use: string, id: string, public: string}|null
	 */
	public static function parse_key( string $use, mixed $id, mixed $public ): ?array {
		if ( ! is_string( $id ) || ! preg_match( '/^[a-z][0-9]{1,3}$/', $id ) || ! is_string( $public ) ) {
			return null;
		}
		$raw = base64_decode( $public, true );
		if ( false === $raw || SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES !== strlen( $raw ) ) {
			return null;
		}
		return array(
			'use'    => $use,
			'id'     => $id,
			'public' => $public,
		);
	}

	public static function save_keys( array $report, array $update ): void {
		update_option( self::REPORT_KEY, $report, true );
		update_option( self::UPDATE_KEY, $update, true );
	}

	/** The release key, which signs Craftish Care's own packages. Never a request key. */
	public static function save_release_key( array $key ): void {
		update_option( self::RELEASE_KEY, $key, false );
	}

	/** @return array{use: string, id: string, public: string}|null */
	public static function release_key(): ?array {
		$key = get_option( self::RELEASE_KEY );
		return is_array( $key ) && isset( $key['id'], $key['use'], $key['public'] ) && 'release' === $key['use'] ? $key : null;
	}

	/** @return array<string, array{use: string, id: string, public: string}> Keys by id. */
	public static function keys(): array {
		$keys = array();
		foreach ( array( self::REPORT_KEY, self::UPDATE_KEY ) as $option ) {
			$key = get_option( $option );
			if ( is_array( $key ) && isset( $key['id'], $key['use'], $key['public'] ) ) {
				$keys[ $key['id'] ] = $key;
			}
		}
		return $keys;
	}

	public static function disconnected_at(): ?int {
		$at = get_option( self::DISCONNECTED );
		return is_numeric( $at ) ? (int) $at : null;
	}

	/** Forgets both keys and every nonce. After this the plugin answers 410 to everything. */
	public static function disconnect(): void {
		update_option( self::DISCONNECTED, time(), false );
		delete_option( self::REPORT_KEY );
		delete_option( self::UPDATE_KEY );
		delete_option( self::RELEASE_KEY );
		delete_option( self::RELEASE );
		self::delete_nonces( null );
	}

	/** @return array<string, array<string, mixed>> The last JOBS_KEPT jobs, by id. */
	public static function jobs(): array {
		$jobs = get_option( self::JOBS, array() );
		return is_array( $jobs ) ? $jobs : array();
	}

	public static function job( string $id ): ?array {
		return self::jobs()[ $id ] ?? null;
	}

	public static function save_job( array $job ): void {
		$jobs                = self::jobs();
		$jobs[ $job['job'] ] = $job;
		update_option( self::JOBS, array_slice( $jobs, -self::JOBS_KEPT, null, true ), false );
	}

	/**
	 * Takes the one-job lock, atomically, as use_nonce does: INSERT IGNORE lets exactly one of two
	 * racing requests in. A lock older than LOCK_TTL is cleared first.
	 */
	public static function lock( string $job ): bool {
		global $wpdb;
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$wpdb->options} WHERE option_name = %s AND CAST(SUBSTRING_INDEX(option_value, ' ', 1) AS UNSIGNED) < %d",
				self::LOCK,
				time() - self::LOCK_TTL
			)
		);
		$rows = $wpdb->query(
			$wpdb->prepare(
				"INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'off')",
				self::LOCK,
				time() . ' ' . $job
			)
		);
		wp_cache_delete( self::LOCK, 'options' );
		return 1 === $rows;
	}

	/** The job holding the lock and since when, or null. */
	public static function lock_holder(): ?array {
		global $wpdb;
		$value = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", self::LOCK ) );
		if ( ! is_string( $value ) || ! preg_match( '/^(\d+) (\S+)$/', $value, $m ) ) {
			return null;
		}
		return array(
			'at'  => (int) $m[1],
			'job' => $m[2],
		);
	}

	public static function unlock( string $job ): void {
		global $wpdb;
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name = %s AND option_value LIKE %s", self::LOCK, '% ' . $wpdb->esc_like( $job ) ) );
		wp_cache_delete( self::LOCK, 'options' );
	}

	/**
	 * Records a nonce, atomically. WordPress's add_option() can't do this: it inserts with
	 * ON DUPLICATE KEY UPDATE, so two racing requests could both succeed. INSERT IGNORE against
	 * the option_name unique key lets exactly one of them in.
	 */
	public static function use_nonce( string $nonce ): bool {
		global $wpdb;
		$name = self::NONCE_PREFIX . hash( 'sha256', $nonce );
		$rows = $wpdb->query(
			$wpdb->prepare(
				"INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'off')",
				$name,
				(string) time()
			)
		);
		return 1 === $rows;
	}

	/** Removes nonces older than NONCE_TTL. Runs from WP-Cron and on each request, since some sites run with cron off. */
	public static function sweep_nonces(): void {
		self::delete_nonces( time() - self::NONCE_TTL );
	}

	private static function delete_nonces( ?int $before ): void {
		global $wpdb;
		$like = $wpdb->esc_like( self::NONCE_PREFIX ) . '%';
		if ( null === $before ) {
			$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s", $like ) );
			return;
		}
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s AND CAST(option_value AS UNSIGNED) < %d LIMIT 500",
				$like,
				$before
			)
		);
	}

	/**
	 * One event on the site's own log: never a request body, header value or IP address.
	 * $key is a key id the plugin already knows, or null.
	 */
	public static function log( string $endpoint, ?string $key, string $result ): void {
		$log   = get_option( self::LOG, array() );
		$log   = is_array( $log ) ? $log : array();
		$log[] = array(
			't'        => time(),
			'endpoint' => $endpoint,
			'key'      => $key,
			'result'   => $result,
		);
		update_option( self::LOG, array_slice( $log, -self::LOG_SIZE ), false );
	}

	/** @return list<array{t: int, endpoint: string, key: ?string, result: string}> Newest first. */
	public static function log_entries(): array {
		$log = get_option( self::LOG, array() );
		return is_array( $log ) ? array_reverse( $log ) : array();
	}

	/** Whether refusals have tripped the limit: more than 20 in a minute blocks for 10 minutes. */
	public static function blocked(): bool {
		$state = self::refusals();
		return $state['blocked_until'] > time();
	}

	/** Counts a refusal. Returns true when this one trips the limit. */
	public static function refused(): bool {
		$now   = time();
		$state = self::refusals();
		if ( $now - $state['start'] >= MINUTE_IN_SECONDS ) {
			$state = array(
				'start'         => $now,
				'count'         => 0,
				'blocked_until' => 0,
			);
		}
		++$state['count'];
		$tripped = $state['count'] > 20;
		if ( $tripped ) {
			$state['blocked_until'] = $now + 10 * MINUTE_IN_SECONDS;
		}
		update_option( self::REFUSALS, $state, false );
		return $tripped;
	}

	/** @return array{start: int, count: int, blocked_until: int} */
	private static function refusals(): array {
		$state = get_option( self::REFUSALS );
		return is_array( $state ) && isset( $state['start'], $state['count'], $state['blocked_until'] )
			? array_map( 'intval', $state )
			: array(
				'start'         => 0,
				'count'         => 0,
				'blocked_until' => 0,
			);
	}

	public static function refreshed_at(): int {
		return (int) get_option( self::REFRESHED, 0 );
	}

	public static function mark_refreshed(): void {
		update_option( self::REFRESHED, time(), false );
	}

	/** Uninstall: every option and nonce this plugin wrote. */
	public static function delete_everything(): void {
		foreach ( self::OPTIONS as $option ) {
			delete_option( $option );
		}
		self::delete_nonces( null );
	}
}
