<?php
/**
 * Tools → Craftish Care: the client's read-only view of what the plugin can do and what it did.
 */

namespace CraftishCare;

defined( 'ABSPATH' ) || exit;

final class Admin {
	const BLOCKER_WORDS = array(
		'below_floor'           => 'WordPress or PHP is older than Craftish Care supports (WordPress 6.6, PHP 8.1).',
		'file_mods_disallowed'  => 'This site doesn’t allow changes to its files (DISALLOW_FILE_MODS).',
		'filesystem_not_direct' => 'Updating here needs FTP or SSH details, which Craftish Care never holds.',
		'plugins_not_writable'  => 'The plugins folder isn’t writable.',
		'themes_not_writable'   => 'The themes folder isn’t writable.',
		'core_not_writable'     => 'WordPress’s own folder isn’t writable.',
	);

	public static function menu(): void {
		add_management_page( 'Craftish Care', 'Craftish Care', 'manage_options', 'craftish-care', array( self::class, 'render' ) );
	}

	public static function render(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Sorry, you are not allowed to access this page.' ) );
		}
		$disconnected = Store::disconnected_at();
		$keys         = Store::keys();
		?>
		<div class="wrap">
			<h1>Craftish Care</h1>
			<p>Craftish Care lets Craftish keep an eye on this site from its own dashboard. Every request is signed, and the plugin checks the signature before doing anything.</p>

			<h2>Connection</h2>
			<?php if ( $disconnected ) : ?>
				<p>Disconnected on <?php echo esc_html( wp_date( 'j F Y, H:i', $disconnected ) ); ?>. Its keys are deleted and it answers nothing. To reconnect, delete the plugin and install a fresh copy from Craftish.</p>
			<?php elseif ( $keys ) : ?>
				<p>Connected, with keys <?php echo esc_html( implode( ' and ', array_keys( $keys ) ) ); ?>.</p>
			<?php else : ?>
				<p>No keys: install the copy Craftish made for this site.</p>
			<?php endif; ?>

			<h2>What it can do</h2>
			<ul class="ul-disc">
				<li>Report this site’s WordPress, plugin and theme versions, the updates WordPress offers for them, the PHP and database versions, and Site Health’s critical results.</li>
				<li>Update WordPress, a plugin or a theme to the version WordPress itself offers, one at a time, when Craftish approves it. WordPress’s own updater does the work.</li>
				<li>Update itself, only to a release Craftish has signed.</li>
				<li>Forget its keys when Craftish disconnects the site.</li>
			</ul>
			<h2>What it can’t do</h2>
			<ul class="ul-disc">
				<li>Read users, posts, pages, settings, files or anything else on the site.</li>
				<li>Install, activate, deactivate or delete anything, or update to any version WordPress doesn’t offer.</li>
				<li>Accept code, files or download links, change settings, or export data.</li>
			</ul>
			<?php
			$blockers = Site::update_blockers();
			if ( $blockers ) :
				?>
				<p>On this site, updates couldn’t run anyway:</p>
				<ul class="ul-disc">
					<?php foreach ( $blockers as $code ) : ?>
						<li><?php echo esc_html( self::BLOCKER_WORDS[ $code ] ?? $code ); ?></li>
					<?php endforeach; ?>
				</ul>
			<?php endif; ?>

			<h2>What it did</h2>
			<?php $entries = Store::log_entries(); ?>
			<?php if ( ! $entries ) : ?>
				<p>Nothing yet.</p>
			<?php else : ?>
				<p>The last <?php echo esc_html( (string) count( $entries ) ); ?> requests, newest first. Refused requests are listed too.</p>
				<table class="widefat striped">
					<thead><tr><th scope="col">When</th><th scope="col">Request</th><th scope="col">Key</th><th scope="col">Result</th></tr></thead>
					<tbody>
					<?php foreach ( $entries as $entry ) : ?>
						<tr>
							<td><?php echo esc_html( wp_date( 'j M Y, H:i:s', (int) $entry['t'] ) ); ?></td>
							<td><?php echo esc_html( (string) $entry['endpoint'] ); ?></td>
							<td><?php echo esc_html( (string) ( $entry['key'] ?? '–' ) ); ?></td>
							<td><?php echo esc_html( (string) $entry['result'] ); ?></td>
						</tr>
					<?php endforeach; ?>
					</tbody>
				</table>
			<?php endif; ?>
		</div>
		<?php
	}
}
