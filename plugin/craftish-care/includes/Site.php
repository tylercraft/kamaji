<?php
/**
 * What the plugin reads (docs/protocol.md, "Capabilities" and "The report"): versions, offered
 * updates, and what would stop an update. Nothing else: no users, options, content or file lists.
 */

namespace CraftishCare;

defined( 'ABSPATH' ) || exit;

final class Site {
	const REFRESH_EVERY = 600;

	private static function load_admin(): void {
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
		require_once ABSPATH . 'wp-admin/includes/theme.php';
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/misc.php';
		require_once ABSPATH . 'wp-admin/includes/update.php';
		require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
		require_once ABSPATH . 'wp-admin/includes/class-wp-automatic-updater.php';
		require_once ABSPATH . 'wp-includes/update.php';
	}

	public static function hello(): array {
		self::load_admin();
		return array(
			'plugin'       => VERSION,
			'protocol'     => PROTOCOL,
			'wordpress'    => get_bloginfo( 'version' ),
			'php'          => PHP_VERSION,
			'multisite'    => is_multisite(),
			'capabilities' => self::capabilities(),
		);
	}

	/** Why an update couldn't run here, in codes Kamaji turns into plain words. */
	public static function update_blockers(): array {
		self::load_admin();
		$blockers = array();
		if ( version_compare( get_bloginfo( 'version' ), MIN_WP, '<' ) || version_compare( PHP_VERSION, MIN_PHP, '<' ) ) {
			$blockers[] = 'below_floor';
		}
		if ( ( defined( 'DISALLOW_FILE_MODS' ) && DISALLOW_FILE_MODS ) || ! wp_is_file_mod_allowed( 'craftish_care_update' ) ) {
			$blockers[] = 'file_mods_disallowed';
		}
		if ( 'direct' !== get_filesystem_method( array(), WP_PLUGIN_DIR ) ) {
			$blockers[] = 'filesystem_not_direct';
		}
		if ( ! wp_is_writable( WP_PLUGIN_DIR ) ) {
			$blockers[] = 'plugins_not_writable';
		}
		if ( ! wp_is_writable( get_theme_root() ) ) {
			$blockers[] = 'themes_not_writable';
		}
		if ( ! wp_is_writable( ABSPATH ) ) {
			$blockers[] = 'core_not_writable';
		}
		return $blockers;
	}

	private static function capabilities(): array {
		$blockers    = self::update_blockers();
		$maintenance = ABSPATH . '.maintenance';
		$loopback    = self::loopback();
		return array(
			'can_report'   => true,
			'can_update'   => array() === $blockers,
			'update_blockers' => $blockers,
			'auto_updates' => array(
				'all_disabled' => ( new \WP_Automatic_Updater() )->is_disabled(),
				'plugins'      => wp_is_auto_update_enabled_for_type( 'plugin' ),
				'themes'       => wp_is_auto_update_enabled_for_type( 'theme' ),
			),
			'maintenance'  => file_exists( $maintenance )
				? array( 'present' => true, 'age_seconds' => max( 0, time() - (int) filemtime( $maintenance ) ) )
				: array( 'present' => false, 'age_seconds' => null ),
			'wp_cron_disabled' => defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON,
			'loopback'     => $loopback,
		);
	}

	/** Site Health's own loopback test: one request from the site to itself. */
	private static function loopback(): array {
		require_once ABSPATH . 'wp-admin/includes/class-wp-site-health.php';
		$result = \WP_Site_Health::get_instance()->can_perform_loopback();
		return array( 'ok' => 'good' === ( $result->status ?? '' ) );
	}

	/** The inventory. With $refresh, reruns WordPress's own update checks first, at most once per 10 minutes. */
	public static function report( bool $refresh ): array {
		self::load_admin();
		$refreshed = false;
		if ( $refresh && time() - Store::refreshed_at() >= self::REFRESH_EVERY ) {
			Store::mark_refreshed();
			delete_site_transient( 'update_plugins' );
			delete_site_transient( 'update_themes' );
			wp_version_check( array(), true );
			wp_update_plugins();
			wp_update_themes();
			$refreshed = true;
		}

		global $wpdb;
		$core_updates    = get_site_transient( 'update_core' );
		$plugin_updates  = get_site_transient( 'update_plugins' );
		$theme_updates   = get_site_transient( 'update_themes' );

		return array(
			'refreshed'   => $refreshed,
			'core'        => array(
				'version' => get_bloginfo( 'version' ),
				'locale'  => get_locale(),
				'offers'  => self::core_offers(),
			),
			'plugins'     => self::plugins( $plugin_updates ),
			'mu_plugins'  => self::mu_plugins(),
			'themes'      => self::themes( $theme_updates ),
			'php'         => PHP_VERSION,
			'database'    => array(
				'server'  => $wpdb->db_server_info(),
				'version' => $wpdb->db_version(),
			),
			'checked_at'  => array(
				'core'    => self::last_checked( $core_updates ),
				'plugins' => self::last_checked( $plugin_updates ),
				'themes'  => self::last_checked( $theme_updates ),
			),
			'site_health' => self::critical_health(),
		);
	}

	private static function last_checked( mixed $transient ): ?int {
		return is_object( $transient ) && isset( $transient->last_checked ) ? (int) $transient->last_checked : null;
	}

	private static function core_offers(): array {
		$offers = array();
		foreach ( (array) get_core_updates( array( 'dismissed' => true ) ) as $offer ) {
			if ( ! is_object( $offer ) || 'latest' === ( $offer->response ?? '' ) ) {
				continue;
			}
			$offers[] = array(
				'version'  => (string) ( $offer->version ?? '' ),
				'locale'   => (string) ( $offer->locale ?? '' ),
				'response' => (string) ( $offer->response ?? '' ),
				'package'  => ! empty( $offer->packages->full ?? $offer->package ?? '' ),
			);
		}
		return $offers;
	}

	private static function offer( mixed $entry ): ?array {
		$entry = is_object( $entry ) ? (array) $entry : $entry;
		if ( ! is_array( $entry ) || empty( $entry['new_version'] ) ) {
			return null;
		}
		return array(
			'version' => (string) $entry['new_version'],
			'package' => ! empty( $entry['package'] ),
		);
	}

	private static function plugins( mixed $updates ): array {
		$response = is_object( $updates ) && isset( $updates->response ) ? (array) $updates->response : array();
		$known    = is_object( $updates ) ? array_merge( (array) ( $updates->no_update ?? array() ), $response ) : array();
		$auto     = (array) get_site_option( 'auto_update_plugins', array() );
		$plugins  = array();
		foreach ( get_plugins() as $file => $data ) {
			$entry = $known[ $file ] ?? null;
			$entry = is_object( $entry ) ? (array) $entry : $entry;
			$slug  = is_array( $entry ) && ! empty( $entry['slug'] )
				? (string) $entry['slug']
				: ( str_contains( $file, '/' ) ? dirname( $file ) : basename( $file, '.php' ) );
			$plugins[] = array(
				'file'        => $file,
				'slug'        => $slug,
				'name'        => wp_strip_all_tags( (string) $data['Name'] ),
				'version'     => (string) $data['Version'],
				'active'      => is_plugin_active( $file ),
				'auto_update' => in_array( $file, $auto, true ),
				'offer'       => self::offer( $response[ $file ] ?? null ),
			);
		}
		return $plugins;
	}

	/** Must-use plugins, as WordPress loads them: listed only, never updated. */
	private static function mu_plugins(): array {
		$mu = array();
		foreach ( get_mu_plugins() as $file => $data ) {
			$mu[] = array(
				'file'    => (string) $file,
				'name'    => wp_strip_all_tags( (string) $data['Name'] ),
				'version' => (string) $data['Version'],
			);
		}
		return $mu;
	}

	private static function themes( mixed $updates ): array {
		$response = is_object( $updates ) && isset( $updates->response ) ? (array) $updates->response : array();
		$auto     = (array) get_site_option( 'auto_update_themes', array() );
		$active   = get_stylesheet();
		$themes   = array();
		foreach ( wp_get_themes() as $stylesheet => $theme ) {
			$template = $theme->get_template();
			$themes[] = array(
				'stylesheet'  => (string) $stylesheet,
				'name'        => wp_strip_all_tags( (string) $theme->get( 'Name' ) ),
				'version'     => (string) $theme->get( 'Version' ),
				'active'      => $stylesheet === $active,
				'parent'      => $template !== $stylesheet ? $template : null,
				'auto_update' => in_array( $stylesheet, $auto, true ),
				'offer'       => self::offer( $response[ $stylesheet ] ?? null ),
			);
		}
		return $themes;
	}

	/** Site Health's direct tests, keeping only the critical ones, as labels. */
	private static function critical_health(): array {
		require_once ABSPATH . 'wp-admin/includes/class-wp-site-health.php';
		require_once ABSPATH . 'wp-admin/includes/class-wp-site-health-auto-updates.php';
		$health   = \WP_Site_Health::get_instance();
		$critical = array();
		foreach ( \WP_Site_Health::get_tests()['direct'] ?? array() as $name => $test ) {
			$callback = $test['test'] ?? null;
			if ( is_string( $callback ) && method_exists( $health, 'get_test_' . $callback ) ) {
				$callback = array( $health, 'get_test_' . $callback );
			}
			if ( ! is_callable( $callback ) ) {
				continue;
			}
			$result = call_user_func( $callback );
			if ( is_array( $result ) && 'critical' === ( $result['status'] ?? '' ) ) {
				$critical[] = array(
					'test'  => (string) $name,
					'label' => wp_strip_all_tags( (string) ( $result['label'] ?? '' ) ),
				);
			}
		}
		return $critical;
	}
}
