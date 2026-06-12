import { ApplicationType, createDefaultApplicationAccessControl, RoleType } from '@logto/schemas';

import {
  createApplication,
  deleteApplication,
  getApplication,
  replaceApplicationAccessControl,
  updateApplication,
} from '#src/api/application.js';
import { assignUsersToRole, createRole, deleteRole } from '#src/api/role.js';
import { logtoConsoleUrl as logtoConsoleUrlString } from '#src/constants.js';
import { OrganizationApiTest } from '#src/helpers/organization.js';
import {
  createDefaultTenantUserWithPassword,
  deleteDefaultTenantUser,
} from '#src/helpers/profile.js';
import { expectToSaveChanges, goToAdminConsole, waitForToast } from '#src/ui-helpers/index.js';
import { appendPathname, devFeatureTest, expectNavigation, generateTestName } from '#src/utils.js';

await page.setViewport({ width: 1920, height: 1080 });

devFeatureTest.describe('application access control Console', () => {
  const logtoConsoleUrl = new URL(logtoConsoleUrlString);

  beforeAll(async () => {
    await goToAdminConsole();
  });

  it('renders rules tab and table details, then saves enabled-state changes', async () => {
    const organizationApi = new OrganizationApiTest();
    const { user, username } = await createDefaultTenantUserWithPassword();
    const userRole = await createRole({ name: generateTestName(), type: RoleType.User });
    const [application, machineToMachineApplication] = await Promise.all([
      createApplication(generateTestName(), ApplicationType.SPA),
      createApplication(generateTestName(), ApplicationType.MachineToMachine),
    ]);

    try {
      const [organization, organizationWithRole] = await Promise.all([
        organizationApi.create({ name: generateTestName() }),
        organizationApi.create({ name: generateTestName() }),
      ]);
      const organizationRole = await organizationApi.roleApi.create({
        name: generateTestName(),
        type: RoleType.User,
      });

      await Promise.all([
        assignUsersToRole([user.id], userRole.id),
        organizationApi.addUsers(organization.id, [user.id]),
        organizationApi.addUsers(organizationWithRole.id, [user.id]),
      ]);
      await organizationApi.addUserRoles(organizationWithRole.id, user.id, [organizationRole.id]);

      await replaceApplicationAccessControl(application.id, {
        ...createDefaultApplicationAccessControl(),
        userIds: [user.id],
        userRoleIds: [userRole.id],
        organizationIds: [organization.id],
        organizationRoleRules: [
          {
            organizationId: organizationWithRole.id,
            organizationRoleIds: [organizationRole.id],
          },
        ],
      });
      await updateApplication(application.id, { appLevelAccessControlEnabled: true });

      await expectNavigation(
        page.goto(
          appendPathname(
            `/console/applications/${machineToMachineApplication.id}/settings`,
            logtoConsoleUrl
          ).href
        )
      );
      await expect(page).toMatchElement('nav a', { text: 'Settings' });

      const machineToMachineRulesTabCount = await page.$$eval(
        'nav a',
        (links) => links.filter((link) => link.textContent?.trim() === 'Rules').length
      );
      expect(machineToMachineRulesTabCount).toBe(0);

      await expectNavigation(
        page.goto(
          appendPathname(`/console/applications/${application.id}/rules`, logtoConsoleUrl).href
        )
      );

      await expect(page).toMatchElement('nav a', { text: 'Rules' });
      await expect(page).toMatchElement('div[class$=title]', {
        text: 'Enable app-level access control',
      });
      await page.waitForSelector('label[class$=switch] input:not(:disabled)');

      const isEnabled = await page.$eval('label[class$=switch] input', (input) => input.checked);
      expect(isEnabled).toBe(true);

      await expect(page).toMatchElement('table tbody tr td', { text: username });
      await expect(page).toMatchElement('table tbody tr td', { text: user.id });
      await expect(page).toMatchElement('table tbody tr td', { text: userRole.name });
      await expect(page).toMatchElement('table tbody tr td', { text: organization.name });
      await expect(page).toMatchElement('table tbody tr td', {
        text: `${organizationWithRole.name} - ${organizationRole.name}`,
      });

      await expect(page).toClick('label[class$=switch]');
      await expectToSaveChanges(page);
      await waitForToast(page, { text: 'Saved' });

      await expect(getApplication(application.id)).resolves.toMatchObject({
        appLevelAccessControlEnabled: false,
      });
    } finally {
      await Promise.allSettled([
        deleteApplication(application.id),
        deleteApplication(machineToMachineApplication.id),
        deleteDefaultTenantUser(user.id),
        deleteRole(userRole.id),
        organizationApi.cleanUp(),
      ]);
    }
  });
});
