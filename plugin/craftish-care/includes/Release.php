<?php
/**
 * Craftish Care's own updates (docs/protocol.md, "Self-update"), through WordPress's update path:
 * the "Update URI" header names Craftish's release channel, WordPress asks it during its usual
 * update checks, and Kamaji updates the plugin with an ordinary update job. Nothing comes from a
 * request. A release is offered only when its signature checks out against the release key, and
 * the zip WordPress downloads is checked against the signed hash before it's installed. Never an
 * older or equal version, and never an automatic update.
 */

namespace CraftishCare;

defined( 'ABSPATH' ) || exit;

final class Release {
	const CHANNEL = 'https://care.craftish.dev/craftish-care/';
	const HOST    = 'care.craftish.dev';

	public static function hooks(): void {
		add_filter( 'update_plugins_' . self::HOST, array( self::class, 'offer' ), 10, 2 );
		add_filter( 'upgrader_pre_download', array( self::class, 'download' ), 10, 4 );
		add_filter( 'auto_update_plugin', array( self::class, 'no_auto_update' ), 100, 2 );
	}

	public static function basename(): string {
		return plugin_basename( dirname( __DIR__ ) . '/craftish-care.php' );
	}

	/** The channel, or the local one wp-config.php names (the DDEV tests only). */
	private static function channel(): string {
		$url = defined( 'CRAFTISH_CARE_RELEASES_URL' ) ? (string) CRAFTISH_CARE_RELEASES_URL : self::CHANNEL;
		return str_starts_with( $url, 'https://' ) ? trailingslashit( $url ) : self::CHANNEL;
	}

	/**
	 * The signed release from info.json, or null. Signed string, one field per line:
	 * craftish-care-release-v1, the version, the zip's SHA-256 (hex).
	 *
	 * @return array{version: string, package: string, sha256: string}|null
	 */
	private static function verified( mixed $info ): ?array {
		$key = Store::release_key();
		if ( ! $key || ! is_array( $info ) ) {
			return null;
		}
		$version   = $info['version'] ?? null;
		$package   = $info['package'] ?? null;
		$sha256    = $info['sha256'] ?? null;
		$key_id    = $info['key'] ?? null;
		$signature = $info['signature'] ?? null;
		if (
			! is_string( $version ) || ! preg_match( '/^\d+\.\d+\.\d+$/', $version )
			|| ! is_string( $package ) || ! str_starts_with( $package, self::channel() )
			|| ! is_string( $sha256 ) || ! preg_match( '/^[0-9a-f]{64}$/', $sha256 )
			|| $key_id !== $key['id'] || ! is_string( $signature )
		) {
			return null;
		}
		$sig = base64_decode( $signature, true );
		$pub = base64_decode( $key['public'], true );
		try {
			$valid = false !== $sig && false !== $pub
				&& sodium_crypto_sign_verify_detached( $sig, "craftish-care-release-v1\n{$version}\n{$sha256}", $pub );
		} catch ( \SodiumException $e ) {
			$valid = false;
		}
		return $valid ? compact( 'version', 'package', 'sha256' ) : null;
	}

	/**
	 * WordPress's update check for this plugin's Update URI.
	 *
	 * @param array|false $update      Another filter's answer.
	 * @param array       $plugin_data This plugin's headers.
	 */
	public static function offer( mixed $update, mixed $plugin_data ): mixed {
		if ( false !== $update ) {
			return $update;
		}
		$response = wp_remote_get( self::channel() . 'info.json', array( 'timeout' => 10 ) );
		if ( is_wp_error( $response ) || 200 !== wp_remote_retrieve_response_code( $response ) ) {
			return $update;
		}
		$release = self::verified( json_decode( wp_remote_retrieve_body( $response ), true ) );
		if ( ! $release || version_compare( $release['version'], VERSION, '<=' ) ) {
			return $update;
		}
		// Kept for the download check, which must match this exact package and hash.
		update_option( Store::RELEASE, $release, false );
		return array(
			'id'      => self::channel(),
			'slug'    => 'craftish-care',
			'version' => $release['version'],
			'url'     => 'https://craftish.dev',
			'package' => $release['package'],
		);
	}

	/**
	 * Before WordPress installs this plugin's package: downloads it here, and refuses it unless its
	 * SHA-256 matches the signed release. Every other package is left to WordPress.
	 */
	public static function download( mixed $reply, mixed $package, mixed $upgrader, mixed $hook_extra = array() ): mixed {
		$ours    = is_array( $hook_extra ) && self::basename() === ( $hook_extra['plugin'] ?? null );
		$release = get_option( Store::RELEASE );
		$known   = is_array( $release ) && ( $release['package'] ?? null ) === $package;
		if ( ! $ours && ! $known ) {
			return $reply;
		}
		if ( ! $known || ! is_string( $package ) ) {
			return new \WP_Error( 'craftish_care_unsigned', 'Craftish Care installs only its own signed releases.' );
		}
		$file = download_url( $package, 300 );
		if ( is_wp_error( $file ) ) {
			return $file;
		}
		if ( ! hash_equals( (string) $release['sha256'], (string) hash_file( 'sha256', $file ) ) ) {
			wp_delete_file( $file );
			return new \WP_Error( 'craftish_care_bad_package', 'The package doesn’t match its signed release.' );
		}
		return $file;
	}

	/** Only Kamaji updates Craftish Care, through an approved job. */
	public static function no_auto_update( mixed $update, mixed $item ): mixed {
		$plugin = is_object( $item ) ? ( $item->plugin ?? null ) : null;
		return self::basename() === $plugin ? false : $update;
	}
}
