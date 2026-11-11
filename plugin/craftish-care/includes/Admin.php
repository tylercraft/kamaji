<?php
/**
 * Tools → Craftish Care: the client's read-only view of what the plugin can do and what it did.
 * The layout and styles are Tyler's design (TY-162, assets/admin.css). Everything shown comes from
 * the plugin's own state, escaped; the status is the connection only, never a verdict on the site.
 */

namespace CraftishCare;

defined( 'ABSPATH' ) || exit;

final class Admin {
	const SLUG = 'craftish-care';

	const BLOCKER_WORDS = array(
		'below_floor'           => 'WordPress or PHP is older than Craftish Care supports (WordPress 6.6, PHP 8.1).',
		'file_mods_disallowed'  => 'This site doesn’t allow changes to its files (DISALLOW_FILE_MODS).',
		'filesystem_not_direct' => 'Updating here needs FTP or SSH details, which Craftish Care never holds.',
		'plugins_not_writable'  => 'The plugins folder isn’t writable.',
		'themes_not_writable'   => 'The themes folder isn’t writable.',
		'core_not_writable'     => 'WordPress’s own folder isn’t writable.',
	);

	public static function menu(): void {
		add_management_page( 'Craftish Care', 'Craftish Care', 'manage_options', self::SLUG, array( self::class, 'render' ) );
	}

	/** The styles, and through them the wordmark's font, on this screen only. */
	public static function enqueue( string $hook ): void {
		if ( 'tools_page_' . self::SLUG !== $hook ) {
			return;
		}
		wp_enqueue_style( 'craftish-care-admin', plugins_url( 'assets/admin.css', dirname( __DIR__ ) . '/craftish-care.php' ), array(), VERSION );
	}

	/**
	 * A log result as the table shows it: its words, and whether it completed, is still going, or
	 * was refused or failed.
	 *
	 * @return array{0: string, 1: string}
	 */
	public static function result_view( string $result ): array {
		if ( 'ok' === $result || str_starts_with( $result, 'ok,' ) ) {
			return array( 'Completed' . substr( $result, 2 ), 'done' );
		}
		$words = ucfirst( $result );
		foreach ( array( 'succeeded', 'stored ' ) as $done ) {
			if ( str_starts_with( $result, $done ) ) {
				return array( $words, 'done' );
			}
		}
		foreach ( array( 'queued', 'running', 'repeat of' ) as $pending ) {
			if ( str_starts_with( $result, $pending ) ) {
				return array( $words, 'pending' );
			}
		}
		return array( $words, 'refused' );
	}

	public static function render(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Sorry, you are not allowed to access this page.' ) );
		}
		$disconnected = Store::disconnected_at();
		$keys         = Store::keys();
		$connected    = ! $disconnected && $keys;
		$entries      = Store::log_entries();
		$blockers     = Site::update_blockers();
		?>
		<div class="wrap">
		<hr class="wp-header-end">
		<div class="craftish-care">
			<header class="cc-header">
				<div class="cc-heading-row">
					<h1>
						<span class="cc-brand"><svg class="cc-mark" viewBox="0 0 100 100" aria-hidden="true"><path fill="currentColor" d="M16 8H88V12A49.28 44 0 0 0 88 88V92H16Q8 92 8 84V16Q8 8 16 8Z"/></svg><span class="cc-wordmark">Craft<span>ish</span></span></span>
						<span class="cc-product">Care</span>
					</h1>
					<span class="cc-status<?php echo $connected ? '' : ' cc-status--off'; ?>"><span class="cc-dot" aria-hidden="true"></span><?php echo esc_html( $connected ? 'Connected' : ( $disconnected ? 'Disconnected' : 'Not connected' ) ); ?></span>
				</div>
				<p class="cc-intro">A connection to Craftish, so I can keep an eye on this site’s software versions, available updates, and Site Health, and run the updates Craftish approves.</p>
			</header>

			<div class="cc-connection">
				<?php if ( $disconnected ) : ?>
					<span><strong>Disconnected on <?php echo esc_html( wp_date( 'j F Y, H:i', $disconnected ) ); ?>.</strong> Its keys are deleted and it answers nothing.</span>
					<span>To reconnect, delete the plugin and install a fresh copy from Craftish.</span>
				<?php elseif ( $keys ) : ?>
					<span><strong>This site is connected to Craftish.</strong></span>
					<span>Active keys &nbsp;<?php echo implode( ' ', array_map( fn( $id ) => '<code>' . esc_html( (string) $id ) . '</code>', array_keys( $keys ) ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- each id is escaped above. ?></span>
				<?php else : ?>
					<span><strong>No keys yet.</strong> Install the copy Craftish made for this site.</span>
				<?php endif; ?>
			</div>

			<section class="cc-scope" aria-label="Plugin capabilities">
				<div>
					<h2>What it can do</h2>
					<ul>
						<li>Report WordPress, plugin, and theme versions, along with updates offered by WordPress.</li>
						<li>Report PHP and database versions, and critical Site Health results.</li>
						<li>Update WordPress, a plugin, or a theme to the version WordPress offers, one at a time, when Craftish approves it. WordPress’s own updater does the work.</li>
						<li>Update itself, only to a release Craftish has signed.</li>
						<li>Forget its keys when Craftish disconnects the site.</li>
					</ul>
				</div>
				<div>
					<h2>What it can’t do</h2>
					<ul>
						<li>Read users, posts, pages, settings, files, or other site content.</li>
						<li>Install, activate, deactivate, or delete anything, or update to a version WordPress doesn’t offer.</li>
						<li>Accept code, files, or download links; change settings; or export data.</li>
					</ul>
				</div>
			</section>
			<?php if ( $blockers ) : ?>
				<div class="cc-blockers">
					<p>On this site, updates couldn’t run anyway:</p>
					<ul>
						<?php foreach ( $blockers as $code ) : ?>
							<li><?php echo esc_html( self::BLOCKER_WORDS[ $code ] ?? $code ); ?></li>
						<?php endforeach; ?>
					</ul>
				</div>
			<?php endif; ?>

			<section class="cc-activity" aria-labelledby="cc-activity-heading">
				<div class="cc-section-head">
					<div>
						<h2 id="cc-activity-heading">Recent activity</h2>
						<p>Requests from Craftish, newest first. Refused requests appear here too.</p>
					</div>
					<?php if ( $entries ) : ?>
						<span class="cc-count"><?php echo esc_html( 1 === count( $entries ) ? '1 request' : count( $entries ) . ' requests' ); ?></span>
					<?php endif; ?>
				</div>
				<?php if ( ! $entries ) : ?>
					<p class="cc-empty">Nothing yet.</p>
				<?php else : ?>
					<div class="cc-table-wrap" role="region" aria-labelledby="cc-activity-heading" tabindex="0">
						<table>
							<thead><tr><th scope="col">When</th><th scope="col">Request</th><th scope="col">Key</th><th scope="col">Result</th></tr></thead>
							<tbody>
							<?php
							foreach ( $entries as $entry ) :
								$at              = (int) $entry['t'];
								[ $words, $kind ] = self::result_view( (string) $entry['result'] );
								?>
								<tr>
									<td><time datetime="<?php echo esc_attr( gmdate( 'c', $at ) ); ?>"><?php echo esc_html( wp_date( 'j M Y', $at ) ); ?> <span class="cc-time"><?php echo esc_html( wp_date( 'H:i:s', $at ) ); ?></span></time></td>
									<td><?php echo esc_html( ucfirst( (string) $entry['endpoint'] ) ); ?></td>
									<td>
									<?php if ( isset( $entry['key'] ) ) : ?>
										<code><?php echo esc_html( (string) $entry['key'] ); ?></code>
									<?php else : ?>
										–
									<?php endif; ?>
									</td>
									<td><span class="cc-result cc-result--<?php echo esc_attr( $kind ); ?>"><?php self::icon( $kind ); ?><?php echo esc_html( $words ); ?></span></td>
								</tr>
							<?php endforeach; ?>
							</tbody>
						</table>
					</div>
					<p class="cc-table-note">A successful report means the request completed. It does not mean the site has no updates or issues.</p>
				<?php endif; ?>
			</section>

			<details class="cc-security">
				<summary>How the connection works</summary>
				<p>Every request is signed. Craftish Care checks the signature before doing anything. The plugin only supports the actions described above, and updates itself only from Craftish’s own release channel, to a release whose signature it has checked.</p>
			</details>

			<footer class="cc-footer">
				<span>Craftish is Tyler Craft.</span>
				<a href="mailto:hello@craftish.dev">Questions? hello@craftish.dev</a>
			</footer>
		</div>
		</div>
		<?php
	}

	/** A tick for done, a cross for refused, nothing for still going. Decorative: the words say it. */
	private static function icon( string $kind ): void {
		if ( 'done' === $kind ) {
			echo '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
		} elseif ( 'refused' === $kind ) {
			echo '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
		}
	}
}
