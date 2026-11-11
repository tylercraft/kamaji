<?php
/**
 * Update jobs (docs/protocol.md, "Update jobs"): one item per job, idempotent by job id, one at a
 * time per site, through WordPress's own upgraders.
 *
 * In the background without WP-Cron: the 202 goes back to Kamaji, then PHP-FPM's
 * fastcgi_finish_request() (or LiteSpeed's equivalent) closes the connection and the job runs on
 * in the same PHP process. No cron event and no loopback request, so DISABLE_WP_CRON and blocked
 * loopbacks don't matter. Where neither function exists, the job runs before the answer is sent:
 * Kamaji's request waits, or times out and asks for the status, while ignore_user_abort keeps
 * the job going.
 */

namespace CraftishCare;

defined( 'ABSPATH' ) || exit;

final class Jobs {
	const ID   = '/^[A-Za-z0-9-]{1,64}$/';
	const TYPES = array( 'core', 'plugin', 'theme' );

	/** The job to run once the response has gone, if any. */
	private static ?array $pending = null;

	/**
	 * @return array{0: int, 1: array<string, mixed>} The status code and body to answer with.
	 */
	public static function start( array $args, string $key ): array {
		$id   = $args['job'] ?? null;
		$type = $args['type'] ?? null;
		$item = $args['item'] ?? null;
		$from = $args['from'] ?? null;
		$to   = $args['to'] ?? null;
		if (
			! is_string( $id ) || ! preg_match( self::ID, $id )
			|| ! in_array( $type, self::TYPES, true )
			|| ! is_string( $item ) || '' === $item || strlen( $item ) > 200
			|| ! is_string( $from ) || ! is_string( $to ) || strlen( $from ) > 64 || strlen( $to ) > 64
			|| ( 'core' === $type ) !== ( 'core' === $item )
		) {
			Store::log( 'update', $key, 'bad_body' );
			return array( 400, array( 'error' => 'bad_body' ) );
		}

		// The same id again: that job's state, never a second run.
		$existing = Store::job( $id );
		if ( $existing ) {
			$same = $existing['type'] === $type && $existing['item'] === $item && $existing['from'] === $from && $existing['to'] === $to;
			if ( ! $same ) {
				Store::log( 'update', $key, 'job_id_reused' );
				return array( 409, array( 'error' => 'job_id_reused' ) );
			}
			Store::log( 'update', $key, 'repeat of ' . self::label( $existing ) );
			return array( 200, self::public_state( $existing ) );
		}

		$offer = self::check_offer( $type, $item, $from, $to );
		if ( is_string( $offer ) ) {
			Store::log( 'update', $key, $offer . ': ' . self::label( compact( 'type', 'item', 'from', 'to' ) ) );
			return array( 409, array( 'error' => $offer ) );
		}

		if ( ! Store::lock( $id ) ) {
			Store::log( 'update', $key, 'busy' );
			return array( 409, array( 'error' => 'busy' ) );
		}

		$job = array(
			'job'    => $id,
			'type'   => $type,
			'item'   => $item,
			'from'   => $from,
			'to'     => $to,
			'state'  => 'queued',
			'queued' => time(),
		);
		Store::save_job( $job );
		Store::log( 'update', $key, 'queued: ' . self::label( $job ) );
		self::$pending = $job;
		// Runs after WordPress has sent the 202 (the REST server ends the request with die()).
		add_action( 'shutdown', array( self::class, 'run_pending' ), 0 );
		return array( 202, array( 'job' => $id, 'state' => 'queued' ) );
	}

	/**
	 * Null when `from` is installed and `to` is exactly WordPress's offer with a package;
	 * otherwise the refusal code. Never takes a version, URL or package from the request.
	 */
	private static function check_offer( string $type, string $item, string $from, string $to ): ?string {
		Site::load_admin();
		if ( 'plugin' === $type ) {
			$installed = get_plugins()[ $item ]['Version'] ?? null;
			$offer     = (array) ( get_site_transient( 'update_plugins' )->response[ $item ] ?? array() );
			$version   = $offer['new_version'] ?? null;
			$package   = $offer['package'] ?? '';
		} elseif ( 'theme' === $type ) {
			$theme     = wp_get_theme( $item );
			$installed = $theme->exists() ? $theme->get( 'Version' ) : null;
			$offer     = (array) ( get_site_transient( 'update_themes' )->response[ $item ] ?? array() );
			$version   = $offer['new_version'] ?? null;
			$package   = $offer['package'] ?? '';
		} else {
			$installed = get_bloginfo( 'version' );
			$core      = self::core_offer( $to );
			$version   = $core ? $core->current : null;
			$package   = $core ? ( $core->packages->full ?? $core->download ?? '' ) : '';
		}
		if ( null === $installed || (string) $installed !== $from || null === $version || (string) $version !== $to ) {
			return 'version_changed';
		}
		return '' === (string) $package ? 'no_package' : null;
	}

	/** WordPress's core offer for exactly this version, in the site's locale if there is one. */
	private static function core_offer( string $to ): ?object {
		$offer = find_core_update( $to, get_locale() ) ?: find_core_update( $to, 'en_US' );
		return is_object( $offer ) && 'upgrade' === ( $offer->response ?? '' ) ? $offer : null;
	}

	public static function run_pending(): void {
		$job = self::$pending;
		if ( ! $job ) {
			return;
		}
		self::$pending = null;
		ignore_user_abort( true );
		if ( function_exists( 'fastcgi_finish_request' ) ) {
			fastcgi_finish_request();
		} elseif ( function_exists( 'litespeed_finish_request' ) ) {
			litespeed_finish_request();
		}
		self::run( $job );
	}

	private static function run( array $job ): void {
		if ( function_exists( 'set_time_limit' ) ) {
			@set_time_limit( Store::LOCK_TTL ); // phpcs:ignore WordPress.PHP.NoSilencedErrors -- some hosts forbid it.
		}
		$job['state']   = 'running';
		$job['started'] = time();
		Store::save_job( $job );

		require_once ABSPATH . 'wp-admin/includes/admin.php';
		require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
		Site::load_admin();
		$skin = new \Automatic_Upgrader_Skin();
		$code = null;
		try {
			if ( 'plugin' === $job['type'] ) {
				// bulk_upgrade, not upgrade(): it keeps an active plugin active, as WordPress's own
				// Updates screen does, where upgrade() deactivates it and waits for a browser.
				$result = ( new \Plugin_Upgrader( $skin ) )->bulk_upgrade( array( $job['item'] ) );
				$result = is_array( $result ) ? ( $result[ $job['item'] ] ?? false ) : $result;
			} elseif ( 'theme' === $job['type'] ) {
				$result = ( new \Theme_Upgrader( $skin ) )->bulk_upgrade( array( $job['item'] ) );
				$result = is_array( $result ) ? ( $result[ $job['item'] ] ?? false ) : $result;
			} else {
				$offer  = self::core_offer( $job['to'] );
				$result = $offer
					? ( new \Core_Upgrader( $skin ) )->upgrade( $offer, array( 'attempt_rollback' => true ) )
					: new \WP_Error( 'version_changed' );
			}
		} catch ( \Throwable $e ) {
			$result = new \WP_Error( 'exception' );
		}

		if ( is_wp_error( $result ) ) {
			$code = $result->get_error_code();
		} elseif ( false === $result || null === $result ) {
			$errors = $skin->get_errors();
			$code   = is_wp_error( $errors ) && $errors->has_errors() ? $errors->get_error_code() : 'upgrade_failed';
		}

		$job['installed']   = self::installed( $job['type'], $job['item'] );
		$job['state']       = null === $code && $job['installed'] === $job['to'] ? 'succeeded' : 'failed';
		$job['error']       = null === $code && 'failed' === $job['state'] ? 'version_not_changed' : $code;
		$job['message']     = null === $job['error'] ? null : self::message( (string) $job['error'] );
		$job['maintenance'] = file_exists( ABSPATH . '.maintenance' );
		$job['finished']    = time();
		Store::save_job( $job );
		Store::unlock( $job['job'] );
		Store::log( 'update', null, $job['state'] . ': ' . self::label( $job ) . ( $job['error'] ? ' (' . $job['error'] . ')' : '' ) );
	}

	/** The version on disk after the run, read fresh rather than from WordPress's caches. */
	private static function installed( string $type, string $item ): ?string {
		if ( 'plugin' === $type ) {
			$file = WP_PLUGIN_DIR . '/' . $item;
			return is_readable( $file ) ? (string) get_plugin_data( $file, false, false )['Version'] : null;
		}
		if ( 'theme' === $type ) {
			wp_clean_themes_cache();
			$theme = wp_get_theme( $item );
			return $theme->exists() ? (string) $theme->get( 'Version' ) : null;
		}
		$wp_version = null;
		include ABSPATH . WPINC . '/version.php'; // Sets $wp_version as installed now.
		return is_string( $wp_version ) ? $wp_version : null;
	}

	/** A short message for an error code: fixed words, never the upgrader's own text. */
	private static function message( string $code ): string {
		return match ( $code ) {
			'version_changed'     => 'WordPress no longer offers this version',
			'version_not_changed' => 'The upgrader finished, but the installed version didn’t change',
			'exception'           => 'The upgrader stopped with an error',
			'interrupted'         => 'The run stopped before it finished',
			default               => 'The upgrader reported ' . preg_replace( '/[^a-z0-9_]/', '', strtolower( $code ) ),
		};
	}

	/**
	 * @return array{0: int, 1: array<string, mixed>}
	 */
	public static function status( array $args, string $key ): array {
		$id = $args['job'] ?? null;
		if ( ! is_string( $id ) || ! preg_match( self::ID, $id ) ) {
			Store::log( 'status', $key, 'bad_body' );
			return array( 400, array( 'error' => 'bad_body' ) );
		}
		$job = Store::job( $id );
		if ( ! $job ) {
			Store::log( 'status', $key, 'unknown_job' );
			return array( 404, array( 'error' => 'unknown_job' ) );
		}
		// A run whose lock is gone or expired, still marked queued or running, died mid-way.
		if ( in_array( $job['state'], array( 'queued', 'running' ), true ) ) {
			$lock = Store::lock_holder();
			if ( ! $lock || $lock['job'] !== $id || time() - $lock['at'] >= Store::LOCK_TTL ) {
				Site::load_admin();
				$job['state']       = 'failed';
				$job['error']       = 'interrupted';
				$job['message']     = self::message( 'interrupted' );
				$job['installed']   = self::installed( $job['type'], $job['item'] );
				$job['maintenance'] = file_exists( ABSPATH . '.maintenance' );
				Store::save_job( $job );
				Store::unlock( $id );
				Store::log( 'update', null, 'failed: ' . self::label( $job ) . ' (interrupted)' );
			}
		}
		Store::log( 'status', $key, $job['state'] );
		return array( 200, self::public_state( $job ) );
	}

	private static function public_state( array $job ): array {
		$state = array(
			'job'   => $job['job'],
			'state' => $job['state'],
		);
		if ( in_array( $job['state'], array( 'succeeded', 'failed' ), true ) ) {
			$state['result'] = array(
				'installed'   => $job['installed'] ?? null,
				'error'       => $job['error'] ?? null,
				'message'     => $job['message'] ?? null,
				'maintenance' => (bool) ( $job['maintenance'] ?? false ),
			);
		}
		return $state;
	}

	private static function label( array $job ): string {
		return sprintf( '%s %s %s → %s', $job['type'], $job['item'], $job['from'], $job['to'] );
	}
}
