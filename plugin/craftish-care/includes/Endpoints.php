<?php
/**
 * The REST surface. Handled in rest_pre_dispatch rather than as registered routes so that nothing
 * of WordPress's own (parameter parsing, JSON errors, the route index) runs before the checks,
 * and only the routes in the protocol's table answer. Everything else under the namespace is 404.
 */

namespace CraftishCare;

defined( 'ABSPATH' ) || exit;

final class Endpoints {
	const NAMESPACE_ROUTE = '/craftish-care/v1';

	/**
	 * @param mixed            $result  Another filter's response, if any.
	 * @param \WP_REST_Server  $server  Unused.
	 * @param \WP_REST_Request $request The request.
	 */
	public static function pre_dispatch( mixed $result, $server, $request ): mixed {
		if ( null !== $result || ! $request instanceof \WP_REST_Request ) {
			return $result;
		}
		$route = $request->get_route();
		if ( self::NAMESPACE_ROUTE !== $route && ! str_starts_with( $route, self::NAMESPACE_ROUTE . '/' ) ) {
			return $result;
		}
		$endpoint = preg_match( '#^/craftish-care/v1/([a-z]+)$#', $route, $m ) ? $m[1] : null;
		$method   = strtoupper( (string) ( $_SERVER['REQUEST_METHOD'] ?? '' ) );
		if ( null === $endpoint || ! isset( Auth::KEY_FOR[ $endpoint ] ) || 'POST' !== $method ) {
			return self::error( 404, 'not_found' );
		}
		if ( Store::blocked() ) {
			return self::error( 429, 'rate_limited' );
		}
		Store::sweep_nonces();
		if ( Store::disconnected_at() ) {
			return self::error( 410, 'disconnected' );
		}
		if ( ! is_ssl() && 'local' !== wp_get_environment_type() ) {
			return self::refuse( $endpoint, 403, 'https_required' );
		}

		$headers = array();
		foreach ( array( 'x-care-key', 'x-care-time', 'x-care-nonce', 'x-care-signature' ) as $name ) {
			$headers[ $name ] = (string) $request->get_header( $name );
		}
		$host  = Auth::normalize_host( (string) ( $_SERVER['HTTP_HOST'] ?? '' ), is_ssl() );
		$body  = (string) $request->get_body();
		$check = Auth::check( $endpoint, $method, $host, $route, $headers, $body, time() );
		if ( ! isset( $check['key'] ) ) {
			return self::refuse( $endpoint, $check[0], $check[1] );
		}

		$key  = $check['key']['id'];
		$args = json_decode( $body, true );
		if ( ! is_array( $args ) || array_is_list( $args ) && array() !== $args ) {
			Store::log( $endpoint, $key, 'bad_body' );
			return self::error( 400, 'bad_body' );
		}
		return self::run( $endpoint, $key, $args );
	}

	private static function run( string $endpoint, string $key, array $args ): \WP_REST_Response {
		switch ( $endpoint ) {
			case 'hello':
				Store::log( 'hello', $key, 'ok' );
				return self::ok( Site::hello() );
			case 'report':
				$data = Site::report( true === ( $args['refresh'] ?? false ) );
				Store::log( 'report', $key, $data['refreshed'] ? 'ok, refreshed' : 'ok' );
				return self::ok( $data );
			case 'status':
				$job = $args['job'] ?? null;
				if ( ! is_string( $job ) || ! preg_match( '/^[A-Za-z0-9-]{1,64}$/', $job ) ) {
					Store::log( 'status', $key, 'bad_body' );
					return self::error( 400, 'bad_body' );
				}
				Store::log( 'status', $key, 'unknown_job' );
				return self::error( 404, 'unknown_job' ); // No update jobs until M4.
			case 'disconnect':
				Store::log( 'disconnect', $key, 'ok' );
				Store::disconnect();
				return self::ok( array( 'disconnected' => true ) );
		}
		return self::error( 404, 'not_found' );
	}

	/** Logs a refusal and counts it toward the rate limit. */
	private static function refuse( string $endpoint, int $status, string $code ): \WP_REST_Response {
		Store::log( $endpoint, null, $code );
		if ( Store::refused() ) {
			Store::log( $endpoint, null, 'rate_limited for 10 minutes' );
		}
		return self::error( $status, $code );
	}

	private static function ok( array $data ): \WP_REST_Response {
		$response = new \WP_REST_Response( $data, 200 );
		$response->header( 'Cache-Control', 'no-store' );
		return $response;
	}

	/** Error bodies are {"error": "<code>"} and never echo input. */
	private static function error( int $status, string $code ): \WP_REST_Response {
		$response = new \WP_REST_Response( array( 'error' => $code ), $status );
		$response->header( 'Cache-Control', 'no-store' );
		return $response;
	}
}
