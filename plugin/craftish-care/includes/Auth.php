<?php
/**
 * The request checks (docs/protocol.md, "Checks"), in the protocol's order, refusing at the first
 * failure. Kept small on purpose: this is the code a bug in would matter most.
 */

namespace CraftishCare;

defined( 'ABSPATH' ) || exit;

final class Auth {
	const WINDOW = 300;

	/** Which key each endpoint takes. The report key can never update or disconnect. */
	const KEY_FOR = array(
		'hello'      => 'report',
		'report'     => 'report',
		'status'     => 'report',
		'update'     => 'update',
		'disconnect' => 'update',
	);

	/**
	 * @param array<string, string> $headers Lowercased header names.
	 * @return array{0: int, 1: string}|array{key: array{use: string, id: string, public: string}}
	 *         A refusal (status, code), or the key that signed the request.
	 */
	public static function check( string $endpoint, string $method, string $host, string $route, array $headers, string $body, int $now ): array {
		// 1. All four headers present and well formed.
		$key_id    = $headers['x-care-key'] ?? '';
		$time      = $headers['x-care-time'] ?? '';
		$nonce     = $headers['x-care-nonce'] ?? '';
		$signature = $headers['x-care-signature'] ?? '';
		if (
			! preg_match( '/^[a-z][0-9]{1,3}$/', $key_id )
			|| ! preg_match( '/^[0-9]{1,12}$/', $time )
			|| ! preg_match( '/^[A-Za-z0-9_-]{22}$/', $nonce )
			|| ! preg_match( '/^[A-Za-z0-9_-]{86}$/', $signature )
		) {
			return array( 400, 'malformed' );
		}

		// 2. Key id known.
		$keys = Store::keys();
		if ( ! isset( $keys[ $key_id ] ) ) {
			return array( 401, 'unknown_key' );
		}
		$key = $keys[ $key_id ];

		// 3. Key allowed for this endpoint.
		if ( ( self::KEY_FOR[ $endpoint ] ?? null ) !== $key['use'] ) {
			return array( 401, 'wrong_key' );
		}

		// 4. Time within 300 seconds of the site's clock.
		if ( abs( $now - (int) $time ) > self::WINDOW ) {
			return array( 401, 'stale' );
		}

		// 5. Signature valid over the string built from the request as received.
		$message = implode(
			"\n",
			array( 'craftish-care-v1', $method, $host, $route, $key_id, $time, $nonce, hash( 'sha256', $body ) )
		);
		$sig = self::base64url_decode( $signature );
		$pub = base64_decode( $key['public'], true );
		try {
			$valid = false !== $sig && false !== $pub
				&& sodium_crypto_sign_verify_detached( $sig, $message, $pub );
		} catch ( \SodiumException $e ) {
			$valid = false;
		}
		if ( ! $valid ) {
			return array( 401, 'bad_signature' );
		}

		// 6. Nonce not seen before.
		if ( ! Store::use_nonce( $nonce ) ) {
			return array( 401, 'replay' );
		}

		// 7. Host matches home_url().
		if ( self::home_host() !== $host ) {
			return array( 401, 'wrong_host' );
		}

		return array( 'key' => $key );
	}

	/** A host as the protocol signs it: lowercase, with the port only when it isn't the default. */
	public static function normalize_host( string $host, bool $https ): string {
		$host = strtolower( trim( $host ) );
		$default = $https ? ':443' : ':80';
		return str_ends_with( $host, $default ) ? substr( $host, 0, -strlen( $default ) ) : $host;
	}

	public static function home_host(): string {
		$home  = wp_parse_url( home_url() );
		$https = 'https' === ( $home['scheme'] ?? '' );
		$host  = ( $home['host'] ?? '' ) . ( isset( $home['port'] ) ? ':' . $home['port'] : '' );
		return self::normalize_host( $host, $https );
	}

	private static function base64url_decode( string $value ): string|false {
		$padded = strtr( $value, '-_', '+/' );
		$padded .= str_repeat( '=', ( 4 - strlen( $padded ) % 4 ) % 4 );
		return base64_decode( $padded, true );
	}
}
